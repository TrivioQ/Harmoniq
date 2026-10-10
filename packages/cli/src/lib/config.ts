// Copyright The Harmoniq Authors
// SPDX-License-Identifier: Apache-2.0

import { chmod, mkdir, readFile, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export interface Profile {
  registryUrl: string;
  apiKey: string;
  workspace: string;
}

interface ConfigFile {
  profiles: Record<string, Profile>;
}

const configDir = () => process.env.HARMONIQ_CONFIG_DIR ?? join(homedir(), '.harmoniq');
export const configPath = () => join(configDir(), 'config.json');

export async function readConfig(): Promise<ConfigFile> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as ConfigFile;
  } catch {
    return { profiles: {} };
  }
}

/** The file holds API keys: owner-only permissions. */
export async function saveProfile(name: string, profile: Profile) {
  const config = await readConfig();
  config.profiles[name] = profile;
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
  await chmod(configPath(), 0o600);
}
