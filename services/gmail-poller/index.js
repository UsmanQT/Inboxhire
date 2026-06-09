require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const LAST_RUN_PATH = path.join(__dirname, 'last_run.json');
const PARSER_URL = process.env.PARSER_SERVICE_URL || 'http://localhost:3001';
const API_URL = process.env.API_SERVICE_URL || 'http://localhost:3002';
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS) || 300000; // 5 mins default

async function authenticate() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES });
  console.log('Authorize this app by visiting this URL:\n', authUrl);
  console.log('\nAfter approval, paste the code below.');

  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    rl.question('Enter the code: ', async (code) => {
      rl.close();
      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
      console.log('Token saved.');
      resolve(oAuth2Client);
    });
  });
}

function getLastRunTimestamp() {
  if (fs.existsSync(LAST_RUN_PATH)) {
    const data = JSON.parse(fs.readFileSync(LAST_RUN_PATH));
    return data.timestamp;
  }
  return null; // First run — fetch all historical emails
}

function saveLastRunTimestamp() {
  fs.writeFileSync(LAST_RUN_PATH, JSON.stringify({ timestamp: Math.floor(Date.now() / 1000) }));
}

function cleanHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '') // remove <style> blocks
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '') // remove <script> blocks
    .replace(/<!--[\s\S]*?-->/g, '')                  // remove comments
    .replace(/<[^>]+>/g, ' ')                         // strip remaining tags
    .replace(/&nbsp;/g, ' ')                          // decode common entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')                             // normalize whitespace
    .trim()
    .slice(0, 1500);
}

function extractBody(payload) {
  // Try plain text first
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').slice(0, 1500);
  }

  // Recurse into parts, collecting plain text first
  if (payload.parts) {
    let htmlFallback = null;
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
      // Collect HTML as fallback
      if (part.mimeType === 'text/html' && part.body?.data) {
        htmlFallback = cleanHtml(Buffer.from(part.body.data, 'base64').toString('utf-8'));
      }
    }
    if (htmlFallback) return htmlFallback;
  }

  // Final fallback: extract from HTML directly
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return cleanHtml(Buffer.from(payload.body.data, 'base64').toString('utf-8'));
  }

  return null;
}

async function parseEmail(subject, from, date, body) {
  try {
    const response = await axios.post(`${PARSER_URL}/parse`, { subject, from, date, body });
    return response.data;
  } catch (err) {
    console.error(`Failed to parse email: ${err.message}`);
    return null;
  }
}

async function fetchJobEmails(auth) {
  const gmail = google.gmail({ version: 'v1', auth });
  const lastRun = getLastRunTimestamp();

  // Build query — add "after:" filter on subsequent runs
  let query = 'subject:("thank you for applying" OR "received your application" OR "application received" OR "application confirmation" OR "you applied" OR "thanks for applying") -subject:("updated your application" OR "withdraw")';
  if (lastRun) {
    query += ` after:${lastRun}`;
    console.log(`📅 Fetching emails since last run (${new Date(lastRun * 1000).toLocaleString()})\n`);
  } else {
    console.log('📅 First run — fetching all historical job emails\n');
  }

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 500,
  });

  const messages = res.data.messages || [];
  console.log(`Found ${messages.length} potential job emails\n`);

  if (messages.length > 200) {
    console.log(`⚠️  More than 200 emails found. Processing first 200 only as a safety limit.`);
    messages.splice(200);
  }

  let saved = 0;
  let skipped = 0;

  for (const message of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
      format: 'full',
    });

    const headers = msg.data.payload.headers;
    const subject = headers.find(h => h.name === 'Subject')?.value;
    const from = headers.find(h => h.name === 'From')?.value;
    const date = headers.find(h => h.name === 'Date')?.value;
    const body = extractBody(msg.data.payload);

    console.log('--- Fetched email ---');
    console.log('Subject:', subject);
    console.log('From:', from);
    console.log('Body:', body ? `${body.slice(0, 120)}...` : 'NULL');

    const parsed = await parseEmail(subject, from, date, body);

    if (parsed) {
      console.log('✅ Parsed result:');
      console.log('   Company:  ', parsed.company || 'Unknown');
      console.log('   Job Title:', parsed.jobTitle || 'Not found');

      try {
        const response = await axios.post(`${API_URL}/applications`, {
          company: parsed.company,
          job_title: parsed.jobTitle,
          email_subject: subject,
          email_from: from,
          applied_date: date,
          gmail_message_id: message.id, // unique ID to prevent duplicates
        });

        if (response.data.skipped) {
          console.log('⏭️  Already in database, skipped');
          skipped++;
        } else {
          console.log('💾 Saved to database');
          saved++;
        }
      } catch (err) {
        console.error('Failed to save to API:', err.message);
      }
    }

    console.log('');
  }

  // Save timestamp so next run only fetches new emails
  saveLastRunTimestamp();
  console.log(`\n✅ Done. Saved: ${saved} | Skipped (duplicates): ${skipped}`);
}

async function main() {
  console.log('🚀 Gmail Poller starting...');
  const auth = await authenticate();

  // Run immediately on start
  await fetchJobEmails(auth);

  // Then poll on interval
  console.log(`\n⏱️  Next poll in ${POLL_INTERVAL_MS / 60000} minutes...`);
  setInterval(async () => {
    console.log('\n🔄 Polling for new emails...');
    await fetchJobEmails(auth);
    console.log(`\n⏱️  Next poll in ${POLL_INTERVAL_MS / 60000} minutes...`);
  }, POLL_INTERVAL_MS);
}

main().catch(console.error);
