// FireLine mission control, over SMS/voice.
// Forwards whatever the user says to the already-deployed /chat endpoint
// (Gemini + Tiger Data live there) and speaks/texts back the reply.
// No LLM call happens here — this file is just the Twilio <-> worker bridge.
import { config } from 'dotenv';
import {
  TAC,
  TACConfig,
  VoiceChannel,
  SMSChannel,
  TACServer,
} from 'twilio-agent-connect';

config();

const WORKER_URL = process.env.FIRELINE_WORKER_URL || 'https://fireline-verdict.fireline-team.workers.dev';

async function askFireline(message) {
  const res = await fetch(`${WORKER_URL}/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    throw new Error(`worker error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.reply;
}

const tac = await TAC.create({ config: TACConfig.fromEnv() });
const voiceChannel = new VoiceChannel(tac);
const smsChannel = new SMSChannel(tac);

// Greet first and wait — without this TAC's default greeting can overlap
// with the caller's own question.
voiceChannel.onInboundCallTwiml(async () => ({
  welcomeGreeting:
    "You've reached FireLine Mission Control. Ask your question — for example, " +
    'is heptane safe at 30 percent oxygen and 0.7 atmospheres.',
}));

tac.onMessageReady(async ({ message }) => {
  try {
    const reply = await askFireline(message);
    // keep it short and plain for voice/SMS, no markdown
    return reply.replace(/[*_`#]/g, '');
  } catch (err) {
    console.error(err);
    return "Mission control couldn't reach the fire data right now — try again in a moment.";
  }
});

const server = new TACServer(tac, { voiceChannel, messagingChannels: [smsChannel] });
await server.start();
console.log('FireLine Twilio agent running, forwarding to', WORKER_URL);
