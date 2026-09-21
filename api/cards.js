import { createClient } from '@supabase/supabase-js';


const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

export default async function handler(req, res) {
  const { method } = req;

  try {
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('cards')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) throw error;

      const formattedCards = data.map(c => ({
        id: c.id,
        owner: c.owner,
        status: c.status,
        memo: c.memo,
        group: c.group,
        company: c.company,
        company_kana: c.company_kana,
        department: c.department,
        title: c.title,
        name: c.name,
        name_kana: c.name_kana,
        address: c.address,
        phone: c.phone,
        mobile: c.mobile,
        email: c.email,
        website: c.website,
        fileUrl: c.file_url,
        avatarUrl: c.avatar_url,
        createdAt: c.created_at
      }));

      return res.status(200).json({ success: true, cards: formattedCards });
    }

    if (method === 'PUT') {
      const card = req.body;
      if (!card || !card.id) {
        return res.status(400).json({ success: false, error: 'カードIDが指定されていません' });
      }

      const { error } = await supabase
        .from('cards')
        .update({
          group: card.group,
          company: card.company,
          company_kana: card.company_kana,
          department: card.department,
          title: card.title,
          name: card.name,
          name_kana: card.name_kana,
          address: card.address,
          phone: card.phone,
          mobile: card.mobile,
          email: card.email,
          website: card.website,
          memo: card.memo,
          updated_at: new Date().toISOString()
        })
        .eq('id', card.id);

      if (error) throw error;

      return res.status(200).json({ success: true });
    }

    if (method === 'POST') {
      const { ids, status } = req.body;
      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        return res.status(200).json({ success: true });
      }

      const { error } = await supabase
        .from('cards')
        .update({
          status: status,
          updated_at: new Date().toISOString()
        })
        .in('id', ids);

      if (error) throw error;

      return res.status(200).json({ success: true });
    }

    res.setHeader('Allow', ['GET', 'PUT', 'POST']);
    res.status(405).end(`Method ${method} Not Allowed`);

  } catch (err) {
    console.error('API Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
}
