require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fetch = require("node-fetch");
const FormData = require("form-data");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Multer for audio uploads (stored in /tmp)
const upload = multer({
  dest: "/tmp/inmersia-uploads/",
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// ─── API Keys from environment ──────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Validate keys on startup
if (!GEMINI_KEY) console.warn("⚠️  GEMINI_API_KEY not set in .env");
if (!OPENAI_KEY) console.warn("⚠️  OPENAI_API_KEY not set in .env");

// ─── Health check ───────────────────────────────────────────────
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    gemini: !!GEMINI_KEY,
    whisper: !!OPENAI_KEY,
  });
});

// ─── CUMBRE AI (Gemini) ─────────────────────────────────────────
// Generic Gemini endpoint for all AI features
app.post("/api/ai/generate", async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  const { prompt, temperature = 0.7, maxTokens = 2048 } = req.body;
  if (!prompt) return res.status(400).json({ error: "prompt is required" });

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens: maxTokens },
        }),
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta";
    res.json({ text });
  } catch (err) {
    console.error("Gemini error:", err.message);
    res.status(500).json({ error: "Error calling Gemini: " + err.message });
  }
});

// ─── Whisper Transcription ──────────────────────────────────────
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!OPENAI_KEY) return res.status(500).json({ error: "OPENAI_API_KEY not configured" });
  if (!req.file) return res.status(400).json({ error: "No audio file provided" });

  try {
    const filePath = req.file.path;
    const form = new FormData();
    form.append("file", fs.createReadStream(filePath), {
      filename: "audio.webm",
      contentType: req.file.mimetype || "audio/webm",
    });
    form.append("model", "whisper-1");
    form.append("language", "es");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI_KEY}` },
      body: form,
    });

    const data = await response.json();

    // Cleanup temp file
    fs.unlink(filePath, () => {});

    if (data.text) {
      res.json({ transcript: data.text });
    } else {
      res.status(500).json({ error: "Whisper returned no text", details: data });
    }
  } catch (err) {
    console.error("Whisper error:", err.message);
    // Cleanup on error
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: "Error transcribing: " + err.message });
  }
});

// ─── Generate Meeting Acta ──────────────────────────────────────
// Combines Whisper + Gemini in one call
app.post("/api/generate-acta", upload.single("audio"), async (req, res) => {
  const { company = "General", participants = "" } = req.body;

  // Step 1: Transcribe with Whisper (if audio provided)
  let transcript = "";

  if (req.file && OPENAI_KEY) {
    try {
      const form = new FormData();
      form.append("file", fs.createReadStream(req.file.path), {
        filename: "audio.webm",
        contentType: req.file.mimetype || "audio/webm",
      });
      form.append("model", "whisper-1");
      form.append("language", "es");

      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_KEY}` },
        body: form,
      });
      const whisperData = await whisperRes.json();
      transcript = whisperData.text || "";
      fs.unlink(req.file.path, () => {});
    } catch (err) {
      console.error("Whisper error in acta:", err.message);
      if (req.file?.path) fs.unlink(req.file.path, () => {});
    }
  } else if (req.body.transcript) {
    transcript = req.body.transcript;
  }

  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  // Step 2: Generate acta with Gemini
  const today = new Date().toLocaleDateString("es-CL", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });

  const actaPrompt = `Genera un ACTA DE REUNION profesional con este formato EXACTO:

**Reunion ${company}**
${today}

| **Fecha** | ${today} |
| **Proyecto** | ${company} – Estrategia de Contenido y Marketing |
| **Tipo de reunion** | Seguimiento y alineacion estrategica |
| **Participantes** | ${participants} |

Basado en esta transcripcion de la reunion:
"${transcript || "(Sin transcripcion disponible - genera un acta de ejemplo para agencia de marketing)"}"

Genera secciones numeradas con los temas tratados, luego una tabla de Proximos Pasos con columnas Accion, Responsable, Plazo.
Termina con "— Fin del acta —"`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: actaPrompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
        }),
      }
    );
    const geminiData = await geminiRes.json();
    const acta = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "Error generando acta";

    // Step 3: Extract tasks from acta
    let tasks = [];
    try {
      const taskPrompt = `Del siguiente acta, extrae las tareas asignadas como JSON: {"tasks":[{"title":"...","responsable":"..."}]}. SOLO JSON, nada mas.\n\n${acta}`;
      const taskRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: taskPrompt }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 1000 },
          }),
        }
      );
      const taskData = await taskRes.json();
      const taskText = taskData?.candidates?.[0]?.content?.parts?.[0]?.text || "";
      const clean = taskText.replace(/```json\n?/g, "").replace(/```/g, "").trim();
      const parsed = JSON.parse(clean);
      if (parsed.tasks) tasks = parsed.tasks;
    } catch {}

    res.json({ acta, transcript, tasks });
  } catch (err) {
    console.error("Acta generation error:", err.message);
    res.status(500).json({ error: "Error generating acta: " + err.message });
  }
});

// ─── Loyalty Push Notification Generator ────────────────────────
app.post("/api/loyalty/generate-push", async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  const { company = "empresa", topic = "promocion" } = req.body;

  const prompt = `Genera una NOTIFICACION PUSH corta (maximo 50 palabras) para la tarjeta de fidelizacion de ${company}. Tema: ${topic}. 
Debe ser: 1) Titulo corto (max 5 palabras) 2) Mensaje breve y directo 3) Call to action claro. 
Luego sugiere 3 horarios optimos de envio con razon breve (ej: "12:30 - hora almuerzo, mayor engagement"). Formato simple y limpio.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.8, maxOutputTokens: 500 },
        }),
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta";
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Meta Ads AI Advisor ────────────────────────────────────────
app.post("/api/meta/advisor", async (req, res) => {
  if (!GEMINI_KEY) return res.status(500).json({ error: "GEMINI_API_KEY not configured" });

  const { company, campaigns, totalBudget, question } = req.body;

  const prompt = `Eres experto en Meta Ads (Facebook/Instagram). Empresa: ${company}. Campanas activas: ${campaigns}, presupuesto total: ${totalBudget}. Pregunta del usuario: ${question}. Incluye recomendaciones de presupuesto, segmentacion y optimizacion.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 1500 },
        }),
      }
    );
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "Sin respuesta";
    res.json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Catch-all: serve frontend ──────────────────────────────────
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════╗
  ║     INMERSIA Server Running          ║
  ║     http://localhost:${PORT}            ║
  ╠══════════════════════════════════════╣
  ║  Gemini API:  ${GEMINI_KEY ? "✅ Configured" : "❌ Missing"}          ║
  ║  Whisper API: ${OPENAI_KEY ? "✅ Configured" : "❌ Missing"}          ║
  ╚══════════════════════════════════════╝
  `);
});
