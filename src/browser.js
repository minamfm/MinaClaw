const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { queryLLM } = require('./llm');
const { executeShellCommand } = require('./tools');

const SKILLS_DIR = process.env.NODE_ENV === 'production'
  ? '/app/skills'
  : path.join(__dirname, '..', 'skills');

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

    const { text: skillContent } = await queryLLM([{ role: 'user', content: prompt }]);

    // Save the skill
    const domain = new URL(url).hostname;
    if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });

    const skillPath = path.join(SKILLS_DIR, `${domain}_skill.md`);
    fs.writeFileSync(skillPath, skillContent.trim());

    return `Successfully learned ${url} and created skill at ${skillPath}`;

  } catch (err) {
    console.error('Browser connection failed:', err);
    return `Failed to connect or learn from browser: ${err.message}`;
  }
}

/**
 * Reads source files from a safe-folder directory, synthesises understanding,
 * and writes a skill markdown file to skills/.
 *
 * @param {string} relativePath  Path relative to /mnt/safe, e.g. "home-dashboard"
 */
async function learnFromDirectory(relativePath) {
  const fullPath = `/mnt/safe/${relativePath.replace(/^\//, '')}`;

  // 1. Verify the directory exists
  const checkOutput = await executeShellCommand(`test -d "${fullPath}" && echo "ok" || echo "notfound"`);
  if (!checkOutput.includes('ok')) {
    return `Directory not found: ${fullPath}\nMake sure it's been added as a safe folder in the CLI.`;
  }

  // 2. Discover source files (skip node_modules, dist, build, .git)
  const EXCLUDE = '! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/.next/*" ! -path "*/coverage/*"';
  const EXT = '\\( -name "*.js" -o -name "*.ts" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.rb" \\)';
  const fileList = await executeShellCommand(
    `find "${fullPath}" -type f ${EXT} ${EXCLUDE} | sort | head -80`
  );
  const files = fileList.split('\n').map(f => f.trim()).filter(Boolean);

  if (!files.length) {
    return `No source files found in ${fullPath}. Supported: .js .ts .jsx .tsx .py .go .rs .java .rb`;
  }

  // 3. Build reading context — prioritise config + likely API/route files
  let context = '';
  const MAX_CHARS = 20_000;

  const addFile = async (filePath, maxLines = 120) => {
    if (context.length >= MAX_CHARS) return;
    const content = await executeShellCommand(`head -${maxLines} "${filePath}" 2>/dev/null`);
    if (!content.trim()) return;
    const relPath = filePath.replace(fullPath + '/', '');
    const block = `\n### ${relPath}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\`\n`;
    context += block;
  };

  // Config / manifest files first
  for (const name of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'pom.xml', 'README.md']) {
    await addFile(`${fullPath}/${name}`, 60);
  }

  // High-priority: files whose names suggest routes/API/server
  const priority = files.filter(f =>
    /route|api|endpoint|controller|handler|server|app|index|main/i.test(path.basename(f))
  );
  for (const f of priority) await addFile(f);

  // Remaining files up to budget
  const rest = files.filter(f => !priority.includes(f));
  for (const f of rest) await addFile(f);

  // 4. Ask LLM to generate the skill file
  const prompt = `You are studying the following codebase to build a skill file for yourself.
The codebase is mounted at ${fullPath} (accessible as /mnt/safe/${relativePath}).

Write a comprehensive skill file in Markdown covering:
- **Overview**: what the application does
- **API Endpoints**: every endpoint found — HTTP method, path, parameters, request body, response format
- **Data models / schemas**: key types and their fields
- **Authentication**: how auth works if present
- **How to interact**: practical examples of calling the API, reading/writing files, etc.
- **Key patterns**: anything non-obvious about the codebase structure

Be specific and concrete — include actual paths, field names, and values from the source.
Do not guess or invent anything not present in the code below.

## Source files
${context}`;

  const { text: skillContent } = await queryLLM([{ role: 'user', content: prompt }]);

  // 5. Save skill file
  if (!fs.existsSync(SKILLS_DIR)) fs.mkdirSync(SKILLS_DIR, { recursive: true });
  const name = relativePath.replace(/[^a-z0-9]/gi, '_').toLowerCase().replace(/_+/g, '_').replace(/^_|_$/g, '');
  const skillPath = path.join(SKILLS_DIR, `${name}_skill.md`);
  fs.writeFileSync(skillPath, skillContent.trim());

  const preview = skillContent.trim().slice(0, 400);
  return `✓ Skill file written: ${name}_skill.md (${files.length} files read)\n\n${preview}…`;
}

module.exports = {
  connectToChromeAndLearn,
  learnFromDirectory,
};
