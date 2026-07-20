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
// The flat list is loaded once and sliced in memory. Querying roots and
// children separately would cost two round trips and, more importantly, would
// leave `selectedDocument` unable to resolve a selected page.
import { listAllDocuments } from '@/lib/db/documents';
import { toAppError } from '@/lib/errors';
import {
  cancelProcessing,
  deleteDocument,
  loadProviderConfig,
  processDocument,
  reconcileInterruptedProcessing,
  renameDocument,
  restoreOriginalName,
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
  // Read by `process` so it can mark a parent's pages without depending on
  // `documents` and re-creating the callback on every refresh.
  const documentsRef = useRef([]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      const docs = await listAllDocuments();
      documentsRef.current = docs;
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
      // A parent marks its pages as processing too, so every affected row in
      // the tree shows activity rather than just the one that was clicked.
      const affected = [documentId, ...documentsRef.current
        .filter((doc) => doc.parentId === documentId)
        .map((doc) => doc.id)];
      setProcessingIds((prev) => {
        const next = new Set(prev);
        affected.forEach((id) => next.add(id));
        return next;
      });

      // Pages complete one at a time, so poll rather than refreshing once at
      // the start — otherwise a 40-page document looks frozen until the end.
      const poll = setInterval(refreshDocuments, 700);
      try {
        await processDocument(documentId);
        return null;
      } catch (err) {
        return toAppError(err);
      } finally {
        clearInterval(poll);
        setProcessingIds((prev) => {
          const next = new Set(prev);
          affected.forEach((id) => next.delete(id));
          return next;
        });
        await refreshDocuments();
      }
    },
    [refreshDocuments]
  );

  const cancel = useCallback((documentId) => cancelProcessing(documentId), []);

  const remove = useCallback(
    async (documentId) => {
      await deleteDocument(documentId);
      setSelectedId((current) => (current === documentId ? null : current));
      await refreshDocuments();
    },
    [refreshDocuments]
  );

  // Renaming touches child page names too, so the whole list is refreshed
  // rather than the single record patched in place.
  const rename = useCallback(
    async (documentId, name) => {
      try {
        await renameDocument(documentId, name);
        return null;
      } catch (err) {
        return toAppError(err);
      } finally {
        await refreshDocuments();
      }
    },
    [refreshDocuments]
  );

  const restoreName = useCallback(
    async (documentId) => {
      await restoreOriginalName(documentId).catch(() => {});
      await refreshDocuments();
    },
    [refreshDocuments]
  );

  const saveProvider = useCallback(async (config) => {
    await saveProviderConfig(config);
    setProviderConfig(config);
  }, []);

  // Sliced once per document change rather than per render: the sidebar shows
  // roots, the tree expands children, and selection must resolve either.
  const { rootDocuments, childrenByParent } = useMemo(() => {
    const roots = [];
    const byParent = new Map();
    for (const doc of documents) {
      if (doc.parentId) {
        if (!byParent.has(doc.parentId)) byParent.set(doc.parentId, []);
        byParent.get(doc.parentId).push(doc);
      } else {
        roots.push(doc);
      }
    }
    for (const pages of byParent.values()) {
      pages.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0));
    }
    return { rootDocuments: roots, childrenByParent: byParent };
  }, [documents]);

  const value = useMemo(
    () => ({
      documents,
      rootDocuments,
      childrenByParent,
      documentsLoaded,
      selectedId,
      setSelectedId,
      // Resolves a page as readily as a root — this lookup is why the flat
      // list is kept in state rather than querying roots only.
      selectedDocument: documents.find((d) => d.id === selectedId) ?? null,
      providerConfig,
      providerLoaded,
      processingIds,
      notice,
      setNotice,
      refreshDocuments,
      upload,
      process,
      cancel,
      remove,
      rename,
      restoreName,
      saveProvider,
    }),
    [
      documents,
      rootDocuments,
      childrenByParent,
      documentsLoaded,
      selectedId,
      providerConfig,
      providerLoaded,
      processingIds,
      notice,
      refreshDocuments,
      upload,
      process,
      cancel,
      remove,
      rename,
      restoreName,
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
