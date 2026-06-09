require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

app.post('/parse', async (req, res) => {
  const { subject, from, date, body } = req.body;

  if (!subject || !from) {
    return res.status(400).json({ error: 'subject and from are required' });
  }

  try {
    const message = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 256,
      messages: [
        {
          role: 'user',
          content: `Extract the company name and job title from this job application email.
Return ONLY a JSON object with keys "company" and "jobTitle".
If you cannot determine the job title, use null.
If you cannot determine the company, use null.

Email Subject: ${subject}
Email From: ${from}
Email Date: ${date}
Email Body (first 1000 chars): ${body || 'Not available'}

Return only valid JSON, no explanation.`
        }
      ]
    });

    let raw = message.content[0].text.trim();
    // Strip markdown code blocks if Claude wrapped the response
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(raw);

    return res.json({
      company: parsed.company || null,
      jobTitle: parsed.jobTitle || null,
      subject,
      from,
      date
    });

  } catch (err) {
    console.error('Parsing error:', err.message);
    return res.status(500).json({ error: 'Failed to parse email' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Parser service running on port ${PORT}`));
