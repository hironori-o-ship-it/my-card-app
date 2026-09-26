import { requireUser, writeAuditLog } from '../lib/auth.js';
import { clip } from '../lib/cards.js';

const geminiApiKey = process.env.GEMINI_API_KEY;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const auth = await requireUser(req, res);
    if (!auth) return;
    const supabase = auth.supabase;

    const { base64Image } = req.body || {};
    if (!base64Image || typeof base64Image !== 'string') {
      return res.status(400).json({ success: false, error: '画像データが送信されていません' });
    }

    const header = base64Image.match(/^data:([^;,]+);base64,/);
    if (!header || !IMAGE_TYPES.includes(header[1].toLowerCase())) {
      return res.status(400).json({ success: false, error: '画像の形式に対応していません（JPEG / PNG / WebP）' });
    }
    const mimeType = header[1].toLowerCase();
    const rawBase64 = base64Image.slice(header[0].length);

    const systemInstruction = "日本のビジネス名刺画像を解析し、JSONスキーマに従って精密に出力してください。複数枚並べて撮影されている場合は配列の中に全てのカードを抽出してください。会社名と氏名のひらがな（company_kana, name_kana）を推測付与し、市外局番と携帯番号を分別してください。未記載は空文字列にしてください。";

    const requestBody = {
      contents: [{
        parts: [
          { text: systemInstruction },
          { inlineData: { mimeType: mimeType, data: rawBase64 } }
        ]
      }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            cards: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  company: { type: "STRING" },
                  company_kana: { type: "STRING" },
                  department: { type: "STRING" },
                  title: { type: "STRING" },
                  name: { type: "STRING" },
                  name_kana: { type: "STRING" },
                  address: { type: "STRING" },
                  phone: { type: "STRING" },
                  mobile: { type: "STRING" },
                  email: { type: "STRING" },
                  website: { type: "STRING" }
                },
                required: ["company", "name"]
              }
            }
          },
          required: ["cards"]
        }
      }
    };

    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });

    if (!geminiRes.ok) {
      const errText = await geminiRes.text();
      console.error(`Gemini API Error (${geminiRes.status}): ${errText}`);
      return res.status(502).json({ success: false, error: 'AIの読み取りに失敗しました。時間をおいて再度お試しください' });
    }

    const geminiJson = await geminiRes.json();
    const textOutput = geminiJson.candidates[0].content.parts[0].text;
    const parsedData = JSON.parse(textOutput);
    const cards = parsedData.cards || [];

    const insertedCards = [];
    const timestamp = new Date().getTime();

    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const cardId = `card_${timestamp}_${i}_${Math.random().toString(36).slice(2, 8)}`;

      const { data, error } = await supabase
        .from('cards')
        .insert([{
          id: cardId,
          owner: auth.email,
          status: '現役',
          group: '主要取引先',
          company: clip(c.company),
          company_kana: clip(c.company_kana),
          department: clip(c.department),
          title: clip(c.title),
          name: clip(c.name),
          name_kana: clip(c.name_kana),
          address: clip(c.address),
          phone: clip(c.phone),
          mobile: clip(c.mobile),
          email: clip(c.email),
          website: clip(c.website),
          file_url: base64Image
        }])
        .select('id, company, name');

      if (error) console.error('DB Insert Error:', error);
      else if (data) insertedCards.push(data[0]);
    }

    if (insertedCards.length) {
      await writeAuditLog(supabase, { email: auth.email, ip: auth.ip, action: 'register_by_photo', targetIds: insertedCards.map((c) => c.id) });
    }
    if (cards.length > 0 && insertedCards.length === 0) {
      return res.status(500).json({ success: false, error: '名刺の保存に失敗しました' });
    }
    if (cards.length === 0) {
      return res.status(200).json({ success: false, error: '名刺を読み取れませんでした。明るい場所で、名刺全体が写るように撮り直してください' });
    }

    // 画像本体は返さない（一覧は /api/cards、画像は /api/cards/image から取る）
    return res.status(200).json({
      success: true,
      cards: insertedCards
    });

  } catch (err) {
    console.error('OCR API Exception:', err);
    return res.status(500).json({ success: false, error: '登録処理に失敗しました' });
  }
}