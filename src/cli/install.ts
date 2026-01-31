/**
 * klausbot install wizard
 *
 * Interactive installation and configuration for klausbot deployment
 */

import { input, confirm, select } from '@inquirer/prompts';
import { execSync } from 'child_process';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { ensureSkillCreator } from './skills.js';
import { theme } from './theme.js';

/**
 * Check if a command exists
 */
function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate .env file content
 */
function generateEnvContent(token: string, dataDir: string): string {
  return `# klausbot configuration
TELEGRAM_BOT_TOKEN=${token}
DATA_DIR=${dataDir}
LOG_LEVEL=info
NODE_ENV=production
`;
}

/**
 * Generate systemd service file content
 */
function generateServiceFile(installDir: string): string {
  return `[Unit]
Description=Klausbot Telegram Gateway
Documentation=https://github.com/yourrepo/klausbot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=klausbot
Group=klausbot
WorkingDirectory=${installDir}
ExecStart=/usr/bin/node ${installDir}/dist/index.js daemon
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
EnvironmentFile=${installDir}/.env

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${installDir}/data

[Install]
WantedBy=multi-user.target
`;
}

/**
 * Run the installation wizard
 */
export async function runInstallWizard(): Promise<void> {
  theme.asciiArt();
  theme.blank();
  theme.header('Installation Wizard');
  theme.blank();
  theme.info('This wizard will help you configure klausbot for your environment.');
  theme.blank();

  // Check prerequisites
  theme.info('Checking prerequisites...');
  theme.blank();

  const hasClaudeCli = commandExists('claude');
  if (hasClaudeCli) {
    theme.success('Claude CLI found');
  } else {
    theme.warn('Claude CLI not found');
    const continueAnyway = await confirm({
      message: 'Claude CLI not detected. Continue anyway?',
      default: false,
    });
    if (!continueAnyway) {
      theme.blank();
      theme.info('Install Claude CLI first: https://claude.ai/code');
      process.exit(1);
    }
  }

  theme.blank();

  // Prompt for bot token
  const botToken = await input({
    message: 'Telegram Bot Token:',
    validate: (value) => {
      if (!value.includes(':')) {
        return 'Invalid token format. Get your token from @BotFather on Telegram.';
      }
      return true;
    },
  });

  // Select deployment mode
  const deployMode = await select({
    message: 'Deployment mode:',
    choices: [
      {
        name: 'systemd (recommended for Linux servers)',
        value: 'systemd',
      },
      {
        name: 'docker (containerized deployment)',
        value: 'docker',
      },
      {
        name: 'dev (development, run foreground)',
        value: 'dev',
      },
    ],
  });

  if (deployMode === 'systemd') {
    await handleSystemdInstall(botToken);
  } else if (deployMode === 'docker') {
    await handleDockerInstall(botToken);
  } else {
    await handleDevInstall(botToken);
  }

  // Install skill-creator for Claude skill authoring
  theme.blank();
  theme.info('Installing skill-creator...');
  try {
    await ensureSkillCreator();
    theme.success('skill-creator installed to ~/.claude/skills/');
  } catch (error) {
    // Non-fatal - user can install later
    theme.warn('Failed to install skill-creator (network error). Run install again later.');
  }
}

/**
 * Handle systemd deployment mode
 */
async function handleSystemdInstall(botToken: string): Promise<void> {
  // Check systemd availability
  if (!commandExists('systemctl')) {
    theme.blank();
    theme.warn('systemd not available on this system.');
    const fallback = await select({
      message: 'Choose alternative:',
      choices: [
        { name: 'Docker', value: 'docker' },
        { name: 'Dev mode', value: 'dev' },
        { name: 'Exit', value: 'exit' },
      ],
    });

    if (fallback === 'docker') {
      return handleDockerInstall(botToken);
    } else if (fallback === 'dev') {
      return handleDevInstall(botToken);
    } else {
      process.exit(0);
    }
  }

  // Prompt for paths
  const installDir = await input({
    message: 'Install directory:',
    default: '/opt/klausbot',
  });

  const dataDir = await input({
    message: 'Data directory:',
    default: `${installDir}/data`,
  });

  // Generate .env file
  const envContent = generateEnvContent(botToken, dataDir);
  const envPath = './.env';

  theme.blank();
  theme.info('Generating configuration...');
  writeFileSync(envPath, envContent);
  theme.success(`Created: ${envPath}`);

  // Generate service file
  const serviceContent = generateServiceFile(installDir);
  const servicePath = './klausbot.service';
  writeFileSync(servicePath, serviceContent);
  theme.success(`Created: ${servicePath}`);

  // Ask to install now
  theme.blank();
  const installNow = await confirm({
    message: 'Install and start systemd service now? (requires sudo)',
    default: false,
  });

  if (installNow) {
    try {
      theme.blank();
      theme.info('Installing systemd service...');

      // Create user if needed
      try {
        execSync('id klausbot', { stdio: 'pipe' });
      } catch {
        theme.info('Creating klausbot user...');
        execSync('sudo useradd -r -s /bin/false klausbot', { stdio: 'inherit' });
      }

      // Create directories
      theme.info('Creating directories...');
      execSync(`sudo mkdir -p ${installDir}`, { stdio: 'inherit' });
      execSync(`sudo mkdir -p ${dataDir}`, { stdio: 'inherit' });
      execSync(`sudo chown -R klausbot:klausbot ${installDir}`, { stdio: 'inherit' });

      // Copy service file
      theme.info('Installing service file...');
      execSync(`sudo cp ${servicePath} /etc/systemd/system/klausbot.service`, { stdio: 'inherit' });

      // Reload and enable
      theme.info('Enabling service...');
      execSync('sudo systemctl daemon-reload', { stdio: 'inherit' });
      execSync('sudo systemctl enable klausbot', { stdio: 'inherit' });
      execSync('sudo systemctl start klausbot', { stdio: 'inherit' });

      theme.blank();
      theme.success('klausbot service installed and started!');
      theme.blank();
      theme.header('Useful commands');
      theme.list([
        'sudo systemctl status klausbot   # Check status',
        'sudo journalctl -u klausbot -f   # View logs',
        'sudo systemctl restart klausbot  # Restart',
      ], { indent: 2 });
    } catch (err) {
      theme.blank();
      theme.error('Installation failed. You can install manually:');
      theme.list([
        `Copy files to ${installDir}`,
        `sudo cp ${servicePath} /etc/systemd/system/`,
        'sudo systemctl daemon-reload',
        'sudo systemctl enable --now klausbot',
      ], { indent: 2 });
    }
  } else {
    theme.blank();
    theme.header('Manual Installation');
    theme.list([
      `Copy project files to ${installDir}`,
      `Copy .env to ${installDir}/.env`,
      `sudo cp ${servicePath} /etc/systemd/system/`,
      'sudo useradd -r -s /bin/false klausbot',
      `sudo mkdir -p ${dataDir}`,
      `sudo chown -R klausbot:klausbot ${installDir}`,
      'sudo systemctl daemon-reload',
      'sudo systemctl enable --now klausbot',
    ], { indent: 2 });
  }
}

/**
 * Handle Docker deployment mode
 */
async function handleDockerInstall(botToken: string): Promise<void> {
  // Check docker availability
  if (!commandExists('docker')) {
    theme.blank();
    theme.error('Docker not found. Please install Docker first.');
    process.exit(1);
  }

  const dataDir = await input({
    message: 'Data directory (host path):',
    default: './data',
  });

  // Generate .env file
  const envContent = generateEnvContent(botToken, '/app/data');
  const envPath = './.env';

  theme.blank();
  theme.info('Generating configuration...');
  writeFileSync(envPath, envContent);
  theme.success(`Created: ${envPath}`);

  // Ensure data dir exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    theme.success(`Created: ${dataDir}/`);
  }

  theme.blank();
  theme.success('Docker deployment ready!');
  theme.blank();
  theme.header('Build and run');
  theme.list([
    'docker build -t klausbot .',
    `docker run -d --name klausbot --env-file .env -v ${dataDir}:/app/data klausbot`,
  ], { indent: 2 });
  theme.blank();
  theme.header('Management');
  theme.list([
    'docker logs -f klausbot   # View logs',
    'docker restart klausbot   # Restart',
    'docker stop klausbot      # Stop',
  ], { indent: 2 });
}

/**
 * Handle dev deployment mode
 */
async function handleDevInstall(botToken: string): Promise<void> {
  const dataDir = await input({
    message: 'Data directory:',
    default: './data',
  });

  // Generate .env file
  const envContent = generateEnvContent(botToken, dataDir);
  const envPath = './.env';

  theme.blank();
  theme.info('Generating configuration...');
  writeFileSync(envPath, envContent);
  theme.success(`Created: ${envPath}`);

  // Ensure data dir exists
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    theme.success(`Created: ${dataDir}/`);
  }

  theme.blank();
  theme.success('Development mode ready!');
  theme.blank();
  theme.header('Run klausbot');
  theme.list([
    'npm run dev',
  ], { indent: 2 });
  theme.blank();
  theme.header('Production build');
  theme.list([
    'npm run build',
    'npm start',
  ], { indent: 2 });
}
