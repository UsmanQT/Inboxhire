require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');
const PARSER_URL = process.env.PARSER_SERVICE_URL || 'http://localhost:3001';

async function authenticate() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

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

function extractBody(payload) {
  // Recursively find plain text part in email payload
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8').slice(0, 1000);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      const result = extractBody(part);
      if (result) return result;
    }
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

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'subject:("thank you for applying" OR "received your application" OR "application received" OR "application confirmation" OR "you applied" OR "thanks for applying") -subject:("updated your application" OR "withdraw")',
    maxResults: 10,
  });

  const messages = res.data.messages || [];
  console.log(`Found ${messages.length} potential job emails\n`);

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

    // Extract plain text body
    const body = extractBody(msg.data.payload);

    console.log('--- Fetched email ---');
    console.log('Subject:', subject);
    console.log('From:', from);

    // Send to parser service
    const parsed = await parseEmail(subject, from, date, body);

    if (parsed) {
      console.log('✅ Parsed result:');
      console.log('   Company:  ', parsed.company || 'Unknown');
      console.log('   Job Title:', parsed.jobTitle || 'Not found');
    }

    console.log('');
  }
}

async function main() {
  console.log('🚀 Gmail Poller starting...');
  const auth = await authenticate();
  await fetchJobEmails(auth);
}

main().catch(console.error);
