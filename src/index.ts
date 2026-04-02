import type { Plugin } from "@opencode-ai/plugin";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";

import { parseConfig } from "./config/schema.js";
import { Indexer } from "./indexer/index.js";
import { createWatcherWithIndexer } from "./watcher/index.js";
import {
  codebase_search,
  codebase_peek,
  index_codebase,
  index_status,
  index_health_check,
  index_metrics,
  index_logs,
  find_similar,
  call_graph,
  implementation_lookup,
  add_knowledge_base,
  list_knowledge_bases,
  remove_knowledge_base,
  initializeTools,
} from "./tools/index.js";
import { loadCommandsFromDirectory } from "./commands/loader.js";
import { hasProjectMarker } from "./utils/files.js";

function getCommandsDir(): string {
  let currentDir = process.cwd();
  
  if (typeof import.meta !== "undefined" && import.meta.url) {
    currentDir = path.dirname(fileURLToPath(import.meta.url));
  }
  
  return path.join(currentDir, "..", "commands");
}

function loadJsonFile(filePath: string): unknown {
  try {
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      return JSON.parse(content);
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Loads and merges global and project configs.
 * 
 * Merge rules:
 * - Global config is the base, project config overrides
 * - For embeddingProvider/customProvider: project overrides global, fallback to global if not set in project
 * - For knowledgeBases: merge arrays (union, deduplicated)
 * - For other fields: project overrides global
 */
function loadPluginConfig(projectRoot: string): unknown {
  const globalConfigPath = path.join(os.homedir(), ".config", "opencode", "codebase-index.json");
  const globalConfig = loadJsonFile(globalConfigPath) as Record<string, unknown> | null;
  const projectConfig = loadJsonFile(path.join(projectRoot, ".opencode", "codebase-index.json")) as Record<string, unknown> | null;

  // If neither exists, return empty
  if (!globalConfig && !projectConfig) {
    return {};
  }

  // If only global exists, return it
  if (!projectConfig && globalConfig) {
    return globalConfig;
  }

  // If only project exists, return it
  if (!globalConfig && projectConfig) {
    return projectConfig;
  }

  // Both exist - merge them
  const merged: Record<string, unknown> = { ...globalConfig };

  // For embedding provider: project overrides global if set, otherwise use global
  if (projectConfig) {
    if (projectConfig.embeddingProvider) {
      merged.embeddingProvider = projectConfig.embeddingProvider;
    }
    if (projectConfig.customProvider) {
      merged.customProvider = projectConfig.customProvider;
    }
    if (projectConfig.embeddingModel) {
      merged.embeddingModel = projectConfig.embeddingModel;
    }

    // For other config sections: project overrides global
    for (const key of Object.keys(projectConfig)) {
      if (key === "embeddingProvider" || key === "customProvider" || key === "embeddingModel" || key === "knowledgeBases" || key === "additionalInclude") {
        continue; // Already handled above or below
      }
      merged[key] = projectConfig[key];
    }

    // For knowledgeBases: merge arrays (union, deduplicated)
    const globalKbs = globalConfig && Array.isArray(globalConfig.knowledgeBases) ? globalConfig.knowledgeBases : [];
    const projectKbs = Array.isArray(projectConfig.knowledgeBases) ? projectConfig.knowledgeBases : [];
    const allKbs = [...globalKbs, ...projectKbs];
    const uniqueKbs = [...new Set(allKbs.map(p => String(p).trim()))];
    merged.knowledgeBases = uniqueKbs;

    // For additionalInclude: merge arrays (union, deduplicated)
    const globalAdditional = globalConfig && Array.isArray(globalConfig.additionalInclude) ? globalConfig.additionalInclude : [];
    const projectAdditional = Array.isArray(projectConfig.additionalInclude) ? projectConfig.additionalInclude : [];
    const allAdditional = [...globalAdditional, ...projectAdditional];
    const uniqueAdditional = [...new Set(allAdditional.map(p => String(p).trim()))];
    merged.additionalInclude = uniqueAdditional;
  }

  return merged;
}

const plugin: Plugin = async ({ directory }) => {
  const projectRoot = directory;
  const rawConfig = loadPluginConfig(projectRoot);
  const config = parseConfig(rawConfig);

  initializeTools(projectRoot, config);

  const indexer = new Indexer(projectRoot, config);

  const isValidProject = !config.indexing.requireProjectMarker || hasProjectMarker(projectRoot);

  if (!isValidProject) {
    console.warn(
      `[codebase-index] Skipping file watching and auto-indexing: no project marker found in "${projectRoot}". ` +
      `Set "indexing.requireProjectMarker": false in config to override.`
    );
  }

  if (config.indexing.autoIndex && isValidProject) {
    indexer.initialize().then(() => {
      indexer.index().catch(() => {});
    }).catch(() => {});
  }

  if (config.indexing.watchFiles && isValidProject) {
    createWatcherWithIndexer(indexer, projectRoot, config);
  }

  return {
    tool: {
      codebase_search,
      codebase_peek,
      index_codebase,
      index_status,
      index_health_check,
      index_metrics,
      index_logs,
      find_similar,
      call_graph,
      implementation_lookup,
      add_knowledge_base,
      list_knowledge_bases,
      remove_knowledge_base,
    },

    async config(cfg) {
      cfg.command = cfg.command ?? {};

      const commandsDir = getCommandsDir();
      const commands = loadCommandsFromDirectory(commandsDir);

      for (const [name, definition] of commands) {
        cfg.command[name] = definition;
      }
    },
  };
};

export default plugin;
