import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const geminiApiKey = process.env.GEMINI_API_KEY;

const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST']);
    return res.status(405).end(`Method ${req.method} Not Allowed`);
  }

  try {
    const { base64Image, fileName } = req.body;
    if (!base64Image) {
      return res.status(400).json({ success: false, error: '画像データが送信されていません' });
    }

    let mimeType = 'image/jpeg';
    let rawBase64 = base64Image;
    if (base64Image.includes(',')) {
      const parts = base64Image.split(',');
      const match = parts[0].match(/:(.*?);/);
      if (match) mimeType = match[1];
      rawBase64 = parts[1];
    }

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
      throw new Error(`Gemini API Error (${geminiRes.status}): ${errText}`);
    }

    const geminiJson = await geminiRes.json();
    const textOutput = geminiJson.candidates[0].content.parts[0].text;
    const parsedData = JSON.parse(textOutput);
    const cards = parsedData.cards || [];

    const insertedCards = [];
    const timestamp = new Date().getTime();

    for (let i = 0; i < cards.length; i++) {
      const c = cards[i];
      const cardId = `card_${timestamp}_${Math.floor(Math.random() * 1000)}`;

      const { data, error } = await supabase
        .from('cards')
        .insert([{
          id: cardId,
          owner: 'Webユーザー',
          status: '現役',
          group: '主要取引先',
          company: c.company || '',
          company_kana: c.company_kana || '',
          department: c.department || '',
          title: c.title || '',
          name: c.name || '',
          name_kana: c.name_kana || '',
          address: c.address || '',
          phone: c.phone || '',
          mobile: c.mobile || '',
          email: c.email || '',
          website: c.website || '',
          file_url: base64Image
        }])
        .select();

      if (error) console.error('DB Insert Error:', error);
      else if (data) insertedCards.push(data[0]);
    }

    return res.status(200).json({
      success: true,
      cards: insertedCards
    });

  } catch (err) {
    console.error('OCR API Exception:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}