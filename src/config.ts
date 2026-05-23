import { PageIndexConfig } from './types';

export const DEFAULT_CONFIG: PageIndexConfig = {
  model: 'claude-sonnet-4-6',
  retrieve_model: 'claude-sonnet-4-6',
  toc_check_page_num: 20,
  max_page_num_each_node: 10,
  max_token_num_each_node: 20000,
  if_add_node_id: 'yes',
  if_add_node_summary: 'yes',
  if_add_doc_description: 'no',
  if_add_node_text: 'no',
};

export function loadConfig(overrides: Partial<PageIndexConfig> = {}): PageIndexConfig {
  const fromEnv: Partial<PageIndexConfig> = {};
  if (process.env.PAGEINDEX_MODEL) fromEnv.model = process.env.PAGEINDEX_MODEL;
  if (process.env.PAGEINDEX_RETRIEVE_MODEL) fromEnv.retrieve_model = process.env.PAGEINDEX_RETRIEVE_MODEL;
  // explicit overrides (e.g. from PageIndexClient options) take highest priority
  return { ...DEFAULT_CONFIG, ...fromEnv, ...overrides };
}
