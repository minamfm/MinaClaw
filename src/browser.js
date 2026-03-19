const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { queryLLM } = require('./llm');

async function connectToChromeAndLearn(url) {
  const cdpUrl = process.env.CHROME_CDP_URL || 'ws://localhost:9222';
  console.log(`Attempting to connect to remote Chrome at ${cdpUrl}`);

  let browser;
  try {
    browser = await chromium.connectOverCDP(cdpUrl);
    const defaultContext = browser.contexts()[0];
    const page = await defaultContext.newPage();
    
    await page.goto(url);
    await page.waitForLoadState('networkidle');

    // Extract basic DOM information to teach the agent
    const pageTitle = await page.title();
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    
    // Close the page so we don't leave artifacts
    await page.close();
    await browser.close();

    // Ask LLM to generate a skill.md
    const prompt = `
I just visited ${url}. The title is "${pageTitle}".
Here is the visible text:
${pageText}

Generate a "skill" Markdown document (skill.md) that describes how I should interact with this site. Include:
1. The purpose of the site.
2. Example tasks I can do.
3. Relevant CSS selectors or actions if any can be deduced.
Return only the Markdown content.
    `;

    const skillContent = await queryLLM([{ role: 'user', content: prompt }]);
    
    // Save the skill
    const domain = new URL(url).hostname;
    const skillsDir = path.join(__dirname, '..', 'skills');
    if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir);
    
    const skillPath = path.join(skillsDir, `${domain}_skill.md`);
    fs.writeFileSync(skillPath, skillContent);
    
    return `Successfully learned ${url} and created skill at ${skillPath}`;

  } catch (err) {
    console.error('Browser connection failed:', err);
    return `Failed to connect or learn from browser: ${err.message}`;
  }
}

module.exports = {
  connectToChromeAndLearn
};
