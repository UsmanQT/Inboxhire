require('dotenv').config();
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

// Only match patterns where company name clearly follows "to/at CompanyName"
// These are high-confidence patterns — company name comes right after a keyword
const COMPANY_PATTERNS = [
  /thank you for applying to ([A-Z][^!.\n]{2,50})(?:\!|\.|\s*$)/i,
  /thanks for applying to ([A-Z][^!.\n]{2,50})(?:\!|\.|\s*$)/i,
  /you applied to ([A-Z][^!.\n]{2,50})(?:\!|\.|\s*$)/i,
  /welcome to ([A-Z][^!.\n]{2,50})(?:'s hiring| careers| jobs)/i,
];

// Patterns where job title clearly comes before "at CompanyName"
const SUBJECT_WITH_AT_PATTERN = /(?:application|applying|applied).*?(?:for\s+(?:the\s+)?)?(.+?)\s+at\s+([A-Z][^!.\n]{2,50})(?:\!|\.|\s*$)/i;

// Generic senders to ignore
const GENERIC_SENDERS = ['no-reply', 'noreply', 'careers', 'hiring', 'jobs', 'recruiting', 'notifications', 'alerts', 'donotreply'];

function tryPatternMatch(subject, from) {
  let company = null;
  let jobTitle = null;

  // First try: subject has "JobTitle at Company" pattern — most reliable
  const atMatch = subject.match(SUBJECT_WITH_AT_PATTERN);
  if (atMatch) {
    jobTitle = atMatch[1].trim();
    company = atMatch[2].trim();
    return { company, jobTitle };
  }

  // Second try: clear "thank you for applying to Company" patterns
  for (const pattern of COMPANY_PATTERNS) {
    const match = subject.match(pattern);
    if (match) {
      company = match[1].trim();
      break;
    }
  }

  // Third try: extract company from sender name only if it looks like a real company name
  if (!company) {
    const senderMatch = from.match(/^"?([^"<@\n]+?)(?:\s+@\s+|\s+Hiring\s|\s+Careers\s|"?\s*<)/i);
    if (senderMatch) {
      const name = senderMatch[1].trim();
      const nameLower = name.toLowerCase();
      const isGeneric = GENERIC_SENDERS.some(g => nameLower.includes(g));
      // Only use sender name if it looks like a company (2+ words or proper noun, not generic)
      if (!isGeneric && name.length > 2 && name.length < 60) {
        company = name;
      }
    }
  }

  return { company, jobTitle };
}

async function parseWithClaude(subject, from, date, body) {
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

Rules:
- Company should be the employer name only (e.g. "Netflix", "Google", "GN Group")
- Job title should be the role name only (e.g. "Software Engineer", "Site Reliability Engineer")
- Do not include words like "for", "at", "the", "position" in your answer
- Do not include reference numbers, requisition IDs (REQ, JR, R followed by numbers) in job title
- For T-Mobile or Workday emails, the company is T-Mobile if the sender contains tmobile

Email Subject: ${subject}
Email From: ${from}
Email Body (first 1500 chars): ${body || 'Not available'}

Return only valid JSON, no explanation.`
      }
    ]
  });

  let raw = message.content[0].text.trim();
  raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(raw);
}

function cleanText(text) {
  if (!text) return null;
  return text
    .replace(/^["'\s\-–,]+/, '')                    // strip leading quotes, dashes, commas
    .replace(/["'\s\-–,]+$/, '')                     // strip trailing quotes, dashes, commas
    .replace(/^(for|at|the)\s+/i, '')                // strip leading "for", "at", "the"
    .replace(/\b(REQ|JR|R|ID|#)\s*\d+\b/gi, '')     // strip requisition numbers like REQ337319, JR0300474
    .replace(/\s+/g, ' ')                            // normalize whitespace
    .trim();
}

function isJunkValue(text) {
  if (!text) return true;
  const lower = text.toLowerCase();
  if (/requisition|req #|job id|job #|\breq\b/.test(lower)) return true;
  if (/^#?\d+$/.test(text.trim())) return true;
  if (text.trim().length < 2) return true;
  return false;
}

function isLikelyJobTitle(text) {
  // If the extracted "company" looks like a job title, reject it
  const jobTitleWords = ['engineer', 'developer', 'manager', 'analyst', 'intern', 'designer', 'specialist', 'coordinator', 'director', 'architect', 'lead', 'scientist', 'position', 'role'];
  const lower = text.toLowerCase();
  return jobTitleWords.some(w => lower.includes(w));
}

app.post('/parse', async (req, res) => {
  const { subject, from, date, body } = req.body;

  if (!subject || !from) {
    return res.status(400).json({ error: 'subject and from are required' });
  }

  try {
    const patternResult = tryPatternMatch(subject, from);

    // If pattern found a company but it looks like a job title — fall back to Claude
    const companyLooksWrong = patternResult.company && isLikelyJobTitle(patternResult.company);

    if (patternResult.company && !companyLooksWrong) {
      const company = cleanText(patternResult.company);
      let jobTitle = cleanText(patternResult.jobTitle);

      // If pattern found company but no job title, try Claude just for the job title
      if (!jobTitle && body) {
        console.log(`✅ Pattern match: ${company} — asking Claude for job title`);
        try {
          const claudeResult = await parseWithClaude(subject, from, date, body);
          jobTitle = cleanText(claudeResult.jobTitle);
        } catch (err) {
          console.error('Claude job title fallback failed:', err.message);
        }
      } else {
        console.log(`✅ Pattern match: ${company}`);
      }

      return res.json({
        company: isJunkValue(company) ? null : company,
        jobTitle: isJunkValue(jobTitle) ? null : jobTitle,
        subject,
        from,
        date,
        source: 'pattern'
      });
    }

    // Fall back to Claude
    console.log(`🤖 Using Claude for: "${subject}"`);
    const claudeResult = await parseWithClaude(subject, from, date, body);

    const company = cleanText(claudeResult.company);
    const jobTitle = cleanText(claudeResult.jobTitle);

    return res.json({
      company: isJunkValue(company) ? null : company,
      jobTitle: isJunkValue(jobTitle) ? null : jobTitle,
      subject,
      from,
      date,
      source: 'claude'
    });

  } catch (err) {
    console.error('Parsing error:', err.message);
    return res.status(500).json({ error: 'Failed to parse email' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Parser service running on port ${PORT}`));
