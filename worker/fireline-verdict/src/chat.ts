// "Mission Control" chatbot: natural-language front end for buildVerdict().
// Flow: user message -> Gemini extracts {o2_fraction, pressure_atm, material}
//       -> buildVerdict() hits Tiger Data -> Gemini turns that JSON into a plain-English answer.
// Routed through Cloudflare AI Gateway so the same call counts for the Cloudflare + Gemini prizes.
import type { Sql } from 'postgres';
import { buildVerdict } from './index';

export interface ChatEnv {
  GEMINI_API_KEY: string;
  AI_GATEWAY_ACCOUNT_ID: string;
  AI_GATEWAY_ID: string;
}

function geminiUrl(env: ChatEnv, model = 'gemini-2.5-flash') {
  // Cloudflare AI Gateway universal endpoint for Google AI Studio.
  return `https://gateway.ai.cloudflare.com/v1/${env.AI_GATEWAY_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/google-ai-studio/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
}

async function callGemini(env: ChatEnv, systemPrompt: string, userText: string, jsonMode: boolean) {
  const res = await fetch(geminiUrl(env), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: jsonMode ? { response_mime_type: 'application/json' } : undefined,
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text()}`);
  const data: any = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

const EXTRACT_PROMPT = `You extract fire-safety test conditions from a question about combustion in microgravity.
Return ONLY JSON: {"o2_fraction": number|null, "pressure_atm": number|null, "material": string|null}.
o2_fraction is 0-1 (30% -> 0.30). pressure_atm is 0-5 (1 atm is normal cabin pressure).
If a number isn't mentioned, use null. Never guess a number that wasn't stated or clearly implied.`;

const ANSWER_PROMPT = `You are Mission Control, a fire-safety assistant for spacecraft combustion questions.
You are given JSON evidence pulled from real NASA PSI combustion test data. Write a short, direct answer:
state PASS/CAUTION/FAIL only if "quantified" is true and relation/evidence supports it; otherwise say
clearly that there's no direct quantified match and summarize the closest research instead.
Always mention the investigation id / DOI you're citing. Never invent numbers not present in the JSON.`;

export async function handleChat(sql: Sql, env: ChatEnv, message: string) {
  const extractedRaw = await callGemini(env, EXTRACT_PROMPT, message, true);
  let extracted: { o2_fraction: number | null; pressure_atm: number | null; material: string | null };
  try {
    extracted = JSON.parse(extractedRaw);
  } catch {
    return { reply: "I couldn't pull O2%/pressure/material out of that — try something like 'is heptane safe at 30% O2 and 0.7 atm?'", verdict: null };
  }

  if (extracted.o2_fraction == null || extracted.pressure_atm == null) {
    return {
      reply: 'I need both an oxygen fraction and a pressure to look this up — e.g. "30% O2 at 0.7 atm, PMMA".',
      verdict: null,
      extracted,
    };
  }

  const verdict = await buildVerdict(sql, {
    o2: extracted.o2_fraction,
    p: extracted.pressure_atm,
    material: extracted.material ?? '',
  });

  const reply = await callGemini(env, ANSWER_PROMPT, JSON.stringify(verdict), false);
  return { reply, verdict, extracted };
}
