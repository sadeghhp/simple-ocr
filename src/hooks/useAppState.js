'use client';

/**
 * Central client state (spec §18): persistent data lives in IndexedDB and is
 * mirrored here for rendering; interface state stays in React.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { listDocuments } from '@/lib/db/documents';
import { toAppError } from '@/lib/errors';
import {
  deleteDocument,
  loadProviderConfig,
  processDocument,
  reconcileInterruptedProcessing,
  saveProviderConfig,
  uploadFiles,
} from '@/lib/workflows';

const AppStateContext = createContext(null);

export function AppStateProvider({ children }) {
  const [documents, setDocuments] = useState([]);
  const [documentsLoaded, setDocumentsLoaded] = useState(false);
  const [selectedId, setSelectedId] = useState(null);
  const [providerConfig, setProviderConfig] = useState(null);
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [processingIds, setProcessingIds] = useState(() => new Set());
  const [notice, setNotice] = useState(null); // { kind: 'error'|'success', text }
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      const docs = await listDocuments();
      if (!mounted.current) return docs;
      setDocuments(docs);
      setDocumentsLoaded(true);
      return docs;
    } catch (err) {
      if (mounted.current) {
        setDocumentsLoaded(true);
        setNotice({ kind: 'error', error: toAppError(err) });
      }
      return [];
    }
  }, []);

  useEffect(() => {
    // Clear any document left mid-processing by a previous session before the
    // first render of the list, so it never appears permanently stuck.
    reconcileInterruptedProcessing()
      .catch(() => {})
      .finally(refreshDocuments);
    loadProviderConfig()
      .then((config) => {
        if (!mounted.current) return;
        setProviderConfig(config);
        setProviderLoaded(true);
      })
      .catch(() => {
        if (mounted.current) setProviderLoaded(true);
      });
  }, [refreshDocuments]);

  const upload = useCallback(
    async (fileList) => {
      const { created, failures } = await uploadFiles(fileList);
      await refreshDocuments();
      if (created.length > 0) setSelectedId(created[0].id);
      if (failures.length > 0) {
        setNotice({ kind: 'error', error: failures[0].error, fileName: failures[0].name });
      } else if (created.length > 0) {
        setNotice({
          kind: 'success',
          text:
            created.length === 1
              ? `“${created[0].name}” stored in your browser.`
              : `${created.length} files stored in your browser.`,
        });
      }
      return { created, failures };
    },
    [refreshDocuments]
  );

  const process = useCallback(
    async (documentId) => {
      setProcessingIds((prev) => new Set(prev).add(documentId));
      // Show the `processing` status row immediately.
      const bump = setTimeout(refreshDocuments, 50);
      try {
        await processDocument(documentId);
        return null;
      } catch (err) {
        return toAppError(err);
      } finally {
        clearTimeout(bump);
        setProcessingIds((prev) => {
          const next = new Set(prev);
          next.delete(documentId);
          return next;
        });
        await refreshDocuments();
      }
    },
    [refreshDocuments]
  );

  const remove = useCallback(
    async (documentId) => {
      await deleteDocument(documentId);
      setSelectedId((current) => (current === documentId ? null : current));
      await refreshDocuments();
    },
    [refreshDocuments]
  );

  const saveProvider = useCallback(async (config) => {
    await saveProviderConfig(config);
    setProviderConfig(config);
  }, []);

  const value = useMemo(
    () => ({
      documents,
      documentsLoaded,
      selectedId,
      setSelectedId,
      selectedDocument: documents.find((d) => d.id === selectedId) ?? null,
      providerConfig,
      providerLoaded,
      processingIds,
      notice,
      setNotice,
      refreshDocuments,
      upload,
      process,
      remove,
      saveProvider,
    }),
    [
      documents,
      documentsLoaded,
      selectedId,
      providerConfig,
      providerLoaded,
      processingIds,
      notice,
      refreshDocuments,
      upload,
      process,
      remove,
      saveProvider,
    ]
  );

  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState() {
  const context = useContext(AppStateContext);
  if (!context) throw new Error('useAppState must be used within AppStateProvider');
  return context;
}
