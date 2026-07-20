// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase, deleteDatabase } from '@/lib/db/database';
import { getDocument, listDocuments, updateDocument } from '@/lib/db/documents';
import { getFile, listFiles } from '@/lib/db/files';
import {
  deleteDocument,
  processDocument,
  reconcileInterruptedProcessing,
  resetEditedText,
  saveEditedText,
  saveProviderConfig,
  loadProviderConfig,
  uploadFile,
  uploadFiles,
} from '@/lib/workflows';
import { emptyProviderConfig } from '@/lib/providers/validation';

const makeFile = (name = 'scan.png', type = 'image/png') =>
  new File([new Uint8Array([1, 2, 3, 4])], name, { type });

const validConfig = () => ({
  ...emptyProviderConfig(),
  name: 'Test',
  endpoint: 'https://api.example.com/v1/chat/completions',
  model: 'test-model',
  apiKey: 'sk',
});

beforeEach(async () => {
  await deleteDatabase();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  closeDatabase();
});

describe('upload workflow', () => {
  it('stores the blob and creates a ready document record', async () => {
    const doc = await uploadFile(makeFile());
    expect(doc.status).toBe('ready');
    expect(doc.schemaVersion).toBe(1);

    const stored = await getDocument(doc.id);
    expect(stored.name).toBe('scan.png');
    const file = await getFile(doc.fileId);
    expect(file.blob.size).toBe(4);
  });

  it('continues past invalid files and reports failures', async () => {
    const { created, failures } = await uploadFiles([
      makeFile('good.png'),
      makeFile('bad.exe', 'application/x-msdownload'),
    ]);
    expect(created).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].error.code).toBe('UNSUPPORTED_FILE');
  });
});

describe('processDocument', () => {
  it('stores normalized extraction and completes', async () => {
    await saveProviderConfig(validConfig());
    const doc = await uploadFile(makeFile());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'OCR text' } }] }), {
          status: 200,
        })
      )
    );
    const updated = await processDocument(doc.id);
    expect(updated.status).toBe('completed');
    expect(updated.extractedText).toBe('OCR text');
    expect(updated.editedText).toBe('OCR text');
    expect(updated.processingError).toBeNull();
  });

  it('marks failed with a normalized error and preserves the file and prior extraction', async () => {
    await saveProviderConfig(validConfig());
    const doc = await uploadFile(makeFile());

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'first pass' } }] }), {
          status: 200,
        })
      )
    );
    await processDocument(doc.id);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('no', { status: 401 })));
    await expect(processDocument(doc.id)).rejects.toMatchObject({
      code: 'AUTHENTICATION_FAILED',
    });

    const after = await getDocument(doc.id);
    expect(after.status).toBe('failed');
    expect(after.processingError.code).toBe('AUTHENTICATION_FAILED');
    expect(after.extractedText).toBe('first pass');
    expect(await getFile(doc.fileId)).not.toBeNull();
  });

  it('fails with PROVIDER_NOT_CONFIGURED when no settings exist', async () => {
    const doc = await uploadFile(makeFile());
    await expect(processDocument(doc.id)).rejects.toMatchObject({
      code: 'PROVIDER_NOT_CONFIGURED',
    });
    expect((await getDocument(doc.id)).status).toBe('failed');
  });

  it('blocks a duplicate request while one is in flight', async () => {
    await saveProviderConfig(validConfig());
    const doc = await uploadFile(makeFile());
    let release;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () =>
              resolve(
                new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), {
                  status: 200,
                })
              );
          })
      )
    );
    const first = processDocument(doc.id);
    // Give the first call a beat to register as in-flight.
    await new Promise((r) => setTimeout(r, 10));
    await expect(processDocument(doc.id)).rejects.toMatchObject({ code: 'ALREADY_PROCESSING' });
    release();
    await first;
  });
});

describe('reconcileInterruptedProcessing', () => {
  it('recovers a document left mid-processing by a closed tab', async () => {
    const doc = await uploadFile(makeFile());
    // Simulate a tab that died after marking the document as processing.
    await updateDocument(doc.id, { status: 'processing' });

    const recovered = await reconcileInterruptedProcessing();
    expect(recovered).toBe(1);

    const after = await getDocument(doc.id);
    expect(after.status).toBe('failed');
    expect(after.processingError.code).toBe('PROCESSING_INTERRUPTED');
    expect(after.processingError.retryable).toBe(true);
    // The file must survive so Retry can work.
    expect(await getFile(doc.fileId)).not.toBeNull();
  });

  it('leaves completed and ready documents untouched', async () => {
    const ready = await uploadFile(makeFile('ready.png'));
    expect(await reconcileInterruptedProcessing()).toBe(0);
    expect((await getDocument(ready.id)).status).toBe('ready');
  });
});

describe('editing', () => {
  it('keeps edits separate and resets to the original extraction', async () => {
    await saveProviderConfig(validConfig());
    const doc = await uploadFile(makeFile());
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content: 'original' } }] }), {
          status: 200,
        })
      )
    );
    await processDocument(doc.id);

    await saveEditedText(doc.id, 'my correction');
    let current = await getDocument(doc.id);
    expect(current.extractedText).toBe('original');
    expect(current.editedText).toBe('my correction');

    current = await resetEditedText(doc.id);
    expect(current.editedText).toBe('original');
  });
});

describe('deleteDocument', () => {
  it('removes both the document and its file record', async () => {
    const doc = await uploadFile(makeFile());
    await deleteDocument(doc.id);
    expect(await getDocument(doc.id)).toBeNull();
    expect(await getFile(doc.fileId)).toBeNull();
    expect(await listDocuments()).toHaveLength(0);
    expect(await listFiles()).toHaveLength(0);
  });
});

describe('provider settings persistence', () => {
  it('round-trips the provider config', async () => {
    await saveProviderConfig(validConfig());
    const loaded = await loadProviderConfig();
    expect(loaded.endpoint).toBe('https://api.example.com/v1/chat/completions');
    expect(loaded.model).toBe('test-model');
  });
});
