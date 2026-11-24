export interface StoredObject {
  key: string;
  byteLength: number;
  contentType: string;
}

export interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ body: Buffer; contentType: string } | null>;
  delete(key: string): Promise<void>;
}

