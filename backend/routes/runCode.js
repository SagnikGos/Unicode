const express = require("express");
const axios = require("axios");
const router = express.Router();

const JUDGE0_URL = "https://judge0-ce.p.rapidapi.com/submissions?base64_encoded=false&wait=true";
const JUDGE0_HEADERS = { 
  "X-RapidAPI-Key": process.env.JUDGE0_API_KEY, 
  "X-RapidAPI-Host": "judge0-ce.p.rapidapi.com",
  "Content-Type": "application/json" 
};

const languageMap = {
  javascript: 63,
  python: 71,
  c: 50,
  cpp: 54
};

router.post("/run", async (req, res) => {
  const { code, language } = req.body;

  if (!code || !languageMap[language]) 
    return res.status(400).json({ error: "Invalid input" });

  try {
    const { data } = await axios.post(JUDGE0_URL, {
        source_code: code,
        language_id: languageMap[language]
      }, { headers: JUDGE0_HEADERS });

    res.json({ 
      stdout: data.stdout || null, 
      stderr: data.stderr || null, 
      compile_output: data.compile_output || null, 
      message: data.message || null 
    });
  } catch (err) {
    res.status(500).json({ error: "Execution error", details: err.message });
  }
});

module.exports = router;
