import { pipeline } from '@huggingface/transformers';

export interface EmbeddingProvider {
  readonly modelId: string;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(query: string): Promise<number[]>;
}

const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';
type Extractor = (texts: string[], options: { pooling: 'mean'; normalize: true }) =>
  Promise<{ tolist(): unknown }>;
const createExtractor = pipeline as unknown as
  (task: 'feature-extraction', model: string, options: { device: 'cpu' }) => Promise<Extractor>;

export class BgeSmallEmbeddings implements EmbeddingProvider {
  readonly modelId = 'Xenova/bge-small-en-v1.5';
  private model?: Promise<Extractor>;

  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    return this.embed(texts);
  }

  async embedQuery(query: string): Promise<number[]> {
    const [vector] = await this.embed([QUERY_PREFIX + query]);
    if (!vector) throw new Error('Embedding model returned no query vector');
    return vector;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    this.model ??= createExtractor('feature-extraction', this.modelId, { device: 'cpu' });
    const extractor = await this.model;
    const output = await extractor(texts, { pooling: 'mean', normalize: true });
    const vectors = output.tolist() as number[][];
    if (vectors.length !== texts.length || vectors.some(vector =>
      vector.length !== 384 || vector.some(value => !Number.isFinite(value)))) {
      throw new Error('Embedding model returned invalid 384-dimensional vectors');
    }
    return vectors;
  }
}
