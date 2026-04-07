/**
 * Channel Router — resolves IM addresses to CodePilot sessions.
 *
 * When a message arrives from an IM channel, the router finds or creates
 * the corresponding ChannelBinding (and underlying chat_session).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ChannelAddress, ChannelBinding, ChannelType } from './types.js';
import { getBridgeContext } from './context.js';

/** Base path for auto-mapping group chats to project directories. */
const GROUP_PROJECT_BASE = '/service/project';

/**
 * Resolve an inbound address to a ChannelBinding.
 * If no binding exists, auto-creates a new session and binding.
 */
export function resolve(address: ChannelAddress): ChannelBinding {
  const { store } = getBridgeContext();
  const existing = store.getChannelBinding(address.channelType, address.chatId);
  if (existing) {
    // Verify the linked session still exists; if not, create a new one
    const session = store.getSession(existing.codepilotSessionId);
    if (session) {
      if (address.displayName) {
        const projectDir = path.join(GROUP_PROJECT_BASE, address.displayName);
        const groupPrompt = `你当前在「${address.displayName}」群中工作。所有创建或生成的文件必须放在 ${projectDir}/ 目录下，禁止放在其他位置。`;
        const needsCwdUpgrade = !existing.workingDirectory.startsWith(GROUP_PROJECT_BASE + '/');
        const needsPromptUpgrade = !session.system_prompt;

        if (needsCwdUpgrade || needsPromptUpgrade) {
          try {
            fs.mkdirSync(projectDir, { recursive: true });
            // Clear SDK session so next query starts fresh with correct CWD + prompt
            store.updateChannelBinding(existing.id, {
              workingDirectory: projectDir,
              sdkSessionId: '',
            });
            existing.workingDirectory = projectDir;
            existing.sdkSessionId = '';
            store.updateSession(existing.codepilotSessionId, {
              working_directory: projectDir,
              system_prompt: groupPrompt,
            });
            console.log('[channel-router] Upgraded binding (cwd=%s, prompt=%s):', needsCwdUpgrade, needsPromptUpgrade, projectDir);
          } catch (err) {
            console.warn('[channel-router] Failed to upgrade binding:', err);
          }
        }
      }
      return existing;
    }
    // Session was deleted — recreate
    return createBinding(address);
  }
  return createBinding(address);
}

/**
 * Create a new binding with a fresh CodePilot session.
 */
export function createBinding(
  address: ChannelAddress,
  workingDirectory?: string,
): ChannelBinding {
  const { store } = getBridgeContext();

  // Auto-derive project directory from group chat name: /service/project/<群名称>/
  let defaultCwd = workingDirectory || '';
  if (!defaultCwd && address.displayName) {
    const projectDir = path.join(GROUP_PROJECT_BASE, address.displayName);
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      defaultCwd = projectDir;
      console.log('[channel-router] Group project directory:', projectDir);
    } catch (err) {
      console.warn('[channel-router] Failed to create project dir:', projectDir, err);
    }
  }
  if (!defaultCwd) {
    defaultCwd = store.getSetting('bridge_default_work_dir')
      || process.env.HOME
      || '';
  }
  const defaultModel = store.getSetting('bridge_default_model') || '';
  const defaultProviderId = store.getSetting('bridge_default_provider_id') || '';

  const displayName = address.displayName || address.chatId;
  // Inject group context so Claude knows where to write files
  const groupPrompt = address.displayName
    ? `你当前在「${address.displayName}」群中工作。所有创建或生成的文件必须放在 ${defaultCwd}/ 目录下，禁止放在其他位置。`
    : undefined;
  const session = store.createSession(
    `Bridge: ${displayName}`,
    defaultModel,
    groupPrompt,
    defaultCwd,
    'code',
  );

  if (defaultProviderId) {
    store.updateSessionProviderId(session.id, defaultProviderId);
  }

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId: session.id,
    sdkSessionId: '',
    workingDirectory: defaultCwd,
    model: defaultModel,
    mode: 'code',
  });
}

/**
 * Bind an IM chat to an existing CodePilot session.
 */
export function bindToSession(
  address: ChannelAddress,
  codepilotSessionId: string,
): ChannelBinding | null {
  const { store } = getBridgeContext();
  const session = store.getSession(codepilotSessionId);
  if (!session) return null;

  return store.upsertChannelBinding({
    channelType: address.channelType,
    chatId: address.chatId,
    codepilotSessionId,
    workingDirectory: session.working_directory,
    model: session.model,
  });
}

/**
 * Update properties of an existing binding.
 */
export function updateBinding(
  id: string,
  updates: Partial<Pick<ChannelBinding, 'sdkSessionId' | 'workingDirectory' | 'model' | 'mode' | 'active'>>,
): void {
  getBridgeContext().store.updateChannelBinding(id, updates);
}

/**
 * List all bindings, optionally filtered by channel type.
 */
export function listBindings(channelType?: ChannelType): ChannelBinding[] {
  return getBridgeContext().store.listChannelBindings(channelType);
}
