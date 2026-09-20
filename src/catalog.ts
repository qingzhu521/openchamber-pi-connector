/**
 * Model/provider catalog: obtained from a throwaway `pi --mode rpc` process
 * (`get_available_models` + `get_state`), translated into OpenCode v2
 * Provider/Model shapes, cached for the adapter lifetime.
 */

import { PiRpcClient } from "./pi-rpc.js";

interface PiModelInfo {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  baseUrl?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

interface OCv2Model {
  id: string;
  providerID: string;
  api: { id: string; url: string; npm: string };
  name: string;
  capabilities: {
    temperature: boolean;
    reasoning: boolean;
    attachment: boolean;
    toolcall: boolean;
    input: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    output: { text: boolean; audio: boolean; image: boolean; video: boolean; pdf: boolean };
    interleaved: boolean;
  };
  cost: { input: number; output: number; cache: { read: number; write: number } };
  limit: { context: number; output: number };
  options: Record<string, unknown>;
}

export interface OCv2Provider {
  id: string;
  name: string;
  source: "config";
  env: string[];
  options: Record<string, unknown>;
  models: Record<string, OCv2Model>;
}

export interface Catalog {
  providers: OCv2Provider[];
  /** providerID → default modelID */
  defaults: Record<string, string>;
}

function toOCModel(m: PiModelInfo): OCv2Model {
  const inputs = new Set(m.input ?? ["text"]);
  const modality = (name: string): boolean => inputs.has(name);
  return {
    id: m.id,
    providerID: m.provider,
    api: { id: m.id, url: m.baseUrl ?? "", npm: "@ai-sdk/openai-compatible" },
    name: m.name ?? m.id,
    capabilities: {
      temperature: true,
      reasoning: m.reasoning ?? false,
      attachment: modality("image"),
      toolcall: true,
      input: { text: modality("text"), audio: false, image: modality("image"), video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: m.reasoning ? true : false,
    },
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cache: { read: m.cost?.cacheRead ?? 0, write: m.cost?.cacheWrite ?? 0 },
    },
    limit: { context: m.contextWindow ?? 0, output: m.maxTokens ?? 0 },
    options: {},
  };
}

export async function loadCatalog(directory: string): Promise<Catalog> {
  const pi = new PiRpcClient({ cwd: directory });
  try {
    const [modelsRes, stateRes] = await Promise.all([
      pi.command<{ models: PiModelInfo[] }>({ type: "get_available_models" }),
      pi.command<{ model: PiModelInfo }>({ type: "get_state" }),
    ]);

    const providers = new Map<string, OCv2Provider>();
    if (modelsRes.success && modelsRes.data) {
      for (const m of modelsRes.data.models) {
        let p = providers.get(m.provider);
        if (!p) {
          p = { id: m.provider, name: m.provider, source: "config", env: [], options: {}, models: {} };
          providers.set(m.provider, p);
        }
        p.models[m.id] = toOCModel(m);
      }
    }

    const defaults: Record<string, string> = {};
    if (stateRes.success && stateRes.data?.model) {
      defaults[stateRes.data.model.provider] = stateRes.data.model.id;
    }

    // OpenChamber's picker defaults to the first listed provider/model — put pi's active config there.
    const sorted = [...providers.values()].sort((a, b) => {
      const aDef = defaults[a.id] !== undefined ? 0 : 1;
      const bDef = defaults[b.id] !== undefined ? 0 : 1;
      return aDef - bDef;
    });
    for (const p of sorted) {
      const def = defaults[p.id];
      if (!def) continue;
      const entries = Object.entries(p.models).sort(([a], [b]) => (a === def ? -1 : b === def ? 1 : 0));
      p.models = Object.fromEntries(entries);
    }

    return { providers: sorted, defaults };
  } finally {
    await pi.dispose();
  }
}
