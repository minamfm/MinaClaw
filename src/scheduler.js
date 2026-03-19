const cron = require('node-cron');
const { queryLLM } = require('./llm');

// In a robust implementation, we'd use a persistent job store like Agenda or SQLite.
// For MVP, we'll use an in-memory map or simple dynamic cron parsing via the LLM.
const scheduledTasks = [];

async function handleScheduling(text, ctx) {
  // We can ask the LLM to parse the reminder into a structured JSON
  const extractionPrompt = `
Extract the scheduling intent from the following text. 
Respond ONLY with a JSON object in this exact format:
{
  "is_reminder": true/false,
  "cron_expression": "string, a valid 5-part cron expression (e.g., '*/15 * * * *')",
  "message_to_send": "string, what to remind the user about"
}
If it is not a reminder or cannot be parsed, set is_reminder to false.
Text: "${text}"
  `;

  try {
    const response = await queryLLM([{ role: 'user', content: extractionPrompt }]);
    const parsed = JSON.parse(response.replace(/```json/g, '').replace(/```/g, '').trim());
    
    if (parsed.is_reminder && parsed.cron_expression) {
      cron.schedule(parsed.cron_expression, () => {
        ctx.reply(`⏰ Reminder: ${parsed.message_to_send}`);
      });
      ctx.reply(`Got it! I've scheduled a reminder for: "${parsed.message_to_send}"`);
      return true;
    }
  } catch (err) {
    console.error('Failed to parse scheduling intent:', err);
  }
  return false;
}

module.exports = {
  handleScheduling
};
