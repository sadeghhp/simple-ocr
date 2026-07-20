/**
 * Pure record migrations, shared by the IndexedDB upgrade path and the
 * importer. A v1 archive and a v1 database must take the identical code path —
 * otherwise the two drift and an old export stops opening.
 */
/**
 * Version of the *record* shape. Lives here rather than in database.js so this
 * module has no imports at all — database.js imports the migration, so the
 * reverse dependency would be a cycle. database.js re-exports this.
 */
export const SCHEMA_VERSION = 3;

/** What a document is, structurally. */
export const DOCUMENT_KIND = {
  /** A standalone upload: one file, one record. Everything from v1 is this. */
  single: 'single',
  /** A multi-page PDF. Owns the blob; holds no extraction of its own. */
  parent: 'parent',
  /** One page of a parent. Owns no blob — rasterized from the parent on demand. */
  page: 'page',
};

/**
 * Fields added in schema v2. Applied to v1 records so every consumer can read
 * them without a presence check.
 *
 * `extractedText` / `editedText` deliberately keep their v1 meaning — plain
 * strings holding the full raw text. Structured data lives in `extraction`,
 * never replacing them.
 */
export function v2Defaults() {
  return {
    kind: DOCUMENT_KIND.single,
    parentId: null,
    pageNumber: null,
    pageCount: null,
    ownsFile: true,
    extraction: null,
    extractionEdited: null,
    extractionWarnings: [],
    documentType: null,
  };
}

/**
 * Fields added in schema v3.
 *
 * `originalName` is the filename as uploaded. It exists because `name` is no
 * longer fixed: once extraction reads a document, its name becomes the subject
 * the model found. Keeping the original is what makes that rename reversible,
 * and it is what a re-run compares against to know the user has not renamed the
 * document by hand.
 */
export function v3Defaults() {
  return {
    originalName: null,
    /**
     * Set once the user has chosen this document's name — by renaming it or by
     * restoring the original. Auto-rename never fires again after that, so
     * re-processing cannot undo a deliberate choice.
     */
    nameLocked: false,
  };
}

/**
 * Bring one document record up to the current schema version.
 * Idempotent: a record already at or beyond SCHEMA_VERSION is returned as-is.
 */
export function migrateDocumentRecord(doc) {
  if (!doc || typeof doc !== 'object') return doc;
  if ((doc.schemaVersion ?? 1) >= SCHEMA_VERSION) return doc;
  const migrated = { ...v2Defaults(), ...v3Defaults(), ...doc, schemaVersion: SCHEMA_VERSION };
  // Pre-v3 records were never renamed, so their current name *is* the original.
  if (migrated.originalName === null) migrated.originalName = migrated.name ?? null;
  return migrated;
}
