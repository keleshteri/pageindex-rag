export interface TreeNode {
  title: string;
  node_id?: string;
  start_index?: number;
  end_index?: number;
  line_num?: number;
  summary?: string;
  prefix_summary?: string;
  text?: string;
  nodes?: TreeNode[];
  [key: string]: unknown;
}

export interface TocEntry {
  structure: string;
  title: string;
  page?: number | null;
  physical_index?: number | null;
  appear_start?: string;
  list_index?: number;
  start_index?: number;
  end_index?: number;
}

export interface IndexResult {
  doc_name: string;
  doc_description?: string;
  structure: TreeNode[];
}

export interface MdIndexResult extends IndexResult {
  line_count: number;
}

// Re-export from module files for convenience
export type { PageIndexOptions } from './pageIndex';
export type { MdIndexOptions } from './pageIndexMd';

export interface DocumentRecord {
  id: string;
  type: 'pdf' | 'md';
  path: string;
  doc_name: string;
  doc_description?: string;
  page_count?: number;
  line_count?: number;
  structure?: TreeNode[];
  pages?: Array<{ page: number; content: string }>;
}

export interface PageIndexConfig {
  model: string;
  retrieve_model: string;
  toc_check_page_num: number;
  max_page_num_each_node: number;
  max_token_num_each_node: number;
  if_add_node_id: 'yes' | 'no';
  if_add_node_summary: 'yes' | 'no';
  if_add_doc_description: 'yes' | 'no';
  if_add_node_text: 'yes' | 'no';
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type FinishReason = 'finished' | 'max_output_reached' | 'error';
