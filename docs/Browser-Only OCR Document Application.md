# Proposal: Browser-Only OCR Document Application

## 1. Project Overview

This application is a browser-only document processing system built with Next.js, JavaScript, HTML, CSS, and Tailwind CSS. Its purpose is to let users upload files, store the original files locally inside the browser, send supported content to a user-defined LLM provider for OCR or text extraction, and store the extracted results in a local schemaless document database.

The application will not depend on a backend server for its core workflow. Original files, extracted text, document metadata, provider settings, and application state will remain inside the user’s browser. The only external communication will occur when the application sends document content to the LLM provider configured by the user.

The MVP will remain deliberately small. It will focus on reliable local document storage, configurable OCR processing, editable extraction results, and a mature user interface. The internal architecture will be designed carefully so the application can grow later without requiring a complete rewrite.

---

## 2. Product Objective

The objective is to create a private, local-first OCR workspace where users can:

1. Upload a supported file.
2. Store the original file in browser storage.
3. Configure a custom LLM provider.
4. send the file or its prepared content to that provider.
5. Receive extracted text.
6. Store the result locally.
7. View the original file and extracted text side by side.
8. Edit the extracted text.
9. Delete documents.
10. Export and import local application data.

The application must feel complete and professional despite having a limited feature set. The quality of the MVP should come from clarity, reliability, consistency, and interface maturity rather than from a large number of features.

---

## 3. Core Product Principles

### 3.1 Browser-Only Operation

The application should operate entirely inside the browser.

Next.js will provide the application structure, routing, build system, and component organization, but the core processing logic should remain client-side. The application should avoid server routes, server actions, and backend-dependent features for the MVP.

A static-export-compatible architecture is preferred because it ensures that the deployed application behaves as a standalone frontend application.

The browser-only model provides several benefits:

* Original files remain on the user’s device.
* Extracted text remains local.
* No backend database is required.
* No server-side account system is required.
* Deployment is simpler.
* Infrastructure cost remains low.
* Privacy boundaries are easier to explain.

The main limitation is that browser storage is not equivalent to permanent cloud storage. Users may clear browser data, browsers may reclaim storage, and private browsing environments may impose stricter limits. Export and import are therefore important parts of the MVP.

---

### 3.2 Local-First Data Ownership

The application should treat the browser as the primary data environment.

Original documents should be stored as binary objects in IndexedDB. Extracted text, document metadata, processing state, and provider configuration should also be stored locally.

The application must clearly distinguish between:

* Data stored only in the browser.
* Data sent temporarily to the selected LLM provider.

This distinction should be visible in the interface, especially during provider configuration and document processing.

---

### 3.3 Minimal Feature Scope

The MVP should include only the features necessary to complete the primary workflow.

The MVP should not include:

* User accounts.
* Cloud synchronization.
* Collaboration.
* Team workspaces.
* Multiple database backends.
* Advanced schema designers.
* Version history.
* Full-text search.
* Analytics.
* Plugin systems.
* Automation rules.
* Multi-provider routing.
* Background processing queues.
* Complex document tagging.
* Sharing links.
* Permission systems.

The application should still be designed so these capabilities can be added later without breaking the current architecture.

---

### 3.4 Mature and Minimal User Experience

The interface should be modern, minimal, and highly polished.

The design should avoid decorative complexity. Visual quality should come from:

* Strong typography.
* Clear hierarchy.
* Consistent spacing.
* Restrained use of color.
* Predictable interaction patterns.
* Clear processing states.
* High-quality empty states.
* Precise error messages.
* Responsive layout.
* Accessible controls.
* Smooth but limited animation.
* Consistent component behavior.

The interface should feel calm, direct, and reliable.

---

## 4. MVP Scope

The MVP includes the following features.

### 4.1 File Upload

Users can upload one or more supported files through:

* A primary upload button.
* Drag and drop.
* The browser file picker.

Each uploaded file should immediately be stored in IndexedDB before OCR processing begins.

The upload process should capture basic metadata:

* File name.
* MIME type.
* File size.
* Upload timestamp.
* Last modified timestamp.
* Internal document identifier.
* Processing status.

The application should reject unsupported files before attempting OCR.

The upload interface should clearly communicate:

* Accepted file types.
* Maximum recommended file size.
* Whether a file is waiting, processing, complete, or failed.

---

### 4.2 Original File Storage

Every original file must be preserved.

The original file should be stored as a `Blob` in IndexedDB. It should not be converted into Base64 unless required temporarily for provider communication.

The application should avoid storing large binary data in LocalStorage because LocalStorage is too limited, synchronous, and inefficient for files.

The original file record should remain unchanged after upload. Extracted text and user edits should be stored separately.

This separation ensures that:

* The original file can always be previewed.
* The file can be reprocessed later.
* User edits do not alter the original source.
* Export operations can include the original file.
* Data remains logically organized.

---

### 4.3 Custom LLM Provider Configuration

The MVP will support one active custom provider configuration.

The user should be able to define:

* Provider name.
* API endpoint.
* Model name.
* API key or token.
* Optional additional request headers.
* Optional request instruction or OCR prompt.

The configuration interface should explain that direct browser communication requires the provider to allow cross-origin requests through CORS.

The provider configuration should be stored locally in IndexedDB or another appropriate browser storage mechanism.

Sensitive values such as API keys cannot be made truly secret in a browser-only application. The application should state this clearly. The key may be stored locally, but any user with access to the browser profile or developer tools may be able to inspect it.

The application should never send provider credentials anywhere except the configured provider endpoint.

---

### 4.4 Provider Adapter Layer

The application should not place provider-specific request logic directly inside UI components.

A small provider adapter layer should convert the application’s internal OCR request into the format expected by the configured provider.

The adapter should be responsible for:

* Building request headers.
* Building the request body.
* Attaching file or image content.
* Sending the HTTP request.
* Interpreting the response.
* Extracting the returned text.
* Converting provider errors into application errors.

Even though the MVP supports only one active custom configuration, using an adapter layer is important. It prevents provider logic from becoming mixed with storage logic and interface code.

The adapter should expose a simple internal contract:

* Input: document content, provider configuration, and OCR instruction.
* Output: normalized extracted text and provider metadata.
* Error: normalized failure information.

The rest of the application should not need to understand the provider’s raw response structure.

---

### 4.5 OCR and Text Extraction

The application should distinguish between text extraction and OCR.

Some files already contain machine-readable text. Others are scans or images and require OCR.

For the MVP, the system should support the simplest reliable workflow:

* Images and photos can be sent directly to a vision-capable LLM provider.
* PDFs may be sent directly if the provider supports PDFs.
* If the provider does not support a file format, the application should return a clear unsupported-format message.

The MVP should not attempt to support every office or document format through complex local conversion.

The processing flow should remain provider-driven:

1. Read the stored file.
2. Prepare the file according to the provider configuration.
3. Send the request.
4. Receive the response.
5. Normalize the extracted text.
6. Store the result.
7. Update processing status.

The application should not silently invent structure that the provider did not return.

---

### 4.6 Schemaless Local Document Storage

The application should use IndexedDB as its local document database.

IndexedDB is suitable because it supports:

* Structured records.
* Large binary objects.
* Asynchronous access.
* Multiple object stores.
* Indexed lookup.
* Larger storage capacity than LocalStorage.

The term “schemaless” should not mean “unstructured.”

The application should use a stable internal document shape while allowing extracted content to remain flexible.

Each document should contain core fields such as:

* `id`
* `fileId`
* `name`
* `mimeType`
* `size`
* `createdAt`
* `updatedAt`
* `status`
* `extractedText`
* `editedText`
* `providerName`
* `model`
* `processingError`
* `documentVersion`
* `schemaVersion`

The extracted result may later include flexible fields, but the MVP should primarily store plain extracted text.

The application should not build a complex schema editor for the MVP.

---

### 4.7 Document List

The document list should display all locally stored documents.

Each item should show:

* File name.
* File type.
* Processing status.
* Upload date.
* File size.
* Error state when relevant.

The list should support:

* Selecting a document.
* Deleting a document.
* Opening an unprocessed document.
* Viewing processing progress.
* Viewing completed documents.

The list should remain visually simple and compact.

No advanced filtering, tagging, or search is required for the MVP.

---

### 4.8 File Preview

The main document workspace should display the original file whenever possible.

Supported previews may include:

* Images using the browser image renderer.
* PDFs using the browser’s built-in PDF support or a locally bundled PDF viewer.
* Plain text files using a text preview.
* Unsupported preview types using a file summary panel.

The preview system should use object URLs created from stored `Blob` objects.

Object URLs should be revoked when no longer needed to avoid memory leaks.

The application should not attempt to provide full document editing.

---

### 4.9 Extracted Text Editor

The extracted result should be displayed in an editable text area.

The editor should support:

* Viewing extracted text.
* Manual correction.
* Saving edits locally.
* Resetting edits to the original extraction result.

The MVP does not require a rich-text editor.

A high-quality plain text editor is sufficient and safer. It avoids unnecessary formatting complexity and reduces the risk of rendering untrusted provider output as HTML.

The application should treat provider output as plain text by default.

---

### 4.10 Processing Status

Every document should have a clear processing state.

Recommended states:

* Uploaded.
* Ready.
* Processing.
* Completed.
* Failed.

The application should not introduce a complex queue system.

The interface should communicate state clearly through:

* Text labels.
* Small status indicators.
* Disabled controls while processing.
* Inline errors.
* Retry action for failed processing.

The system should prevent duplicate OCR requests for the same document while processing is active.

---

### 4.11 Delete Document

Users should be able to delete a document.

Deleting a document should remove:

* The original file.
* Document metadata.
* Extracted text.
* User edits.
* Processing error data.
* Related local records.

The interface should require confirmation because deletion is permanent inside the local browser database.

The confirmation should clearly state that the file and extracted result will be removed from the browser.

---

### 4.12 Export and Import

The application should support exporting local data.

The export should include:

* Original files.
* Document metadata.
* Extracted text.
* Edited text.
* Provider-independent document information.
* Application schema version.

Provider credentials should not be included by default because export files may be stored or shared insecurely.

The export format may be a structured archive containing:

* A metadata JSON file.
* Original binary files.
* Extraction result files.

Import should restore the documents into IndexedDB.

The application should validate imported data before writing it to storage.

The import process should reject unsupported archive versions or malformed records with a clear error.

---

## 5. Recommended Application Structure

The application should use a clear modular structure.

A recommended organization is:

```text
src/
  app/
    page.js
    layout.js
    globals.css

  components/
    layout/
    documents/
    preview/
    editor/
    provider/
    feedback/
    common/

  lib/
    db/
    providers/
    files/
    export/
    validation/
    utils/

  hooks/
    useDocuments.js
    useDocument.js
    useProviderSettings.js
    useStorageEstimate.js

  types/
    document.js
    provider.js
    database.js
```

Even in JavaScript, clear module boundaries should be maintained.

---

## 6. Architectural Layers

### 6.1 Presentation Layer

The presentation layer contains:

* Pages.
* Layout components.
* Buttons.
* Dialogs.
* Sidebars.
* Forms.
* Preview components.
* Text editor.
* Status indicators.
* Empty states.
* Error messages.

UI components should not directly access IndexedDB or call the provider.

They should receive data and actions through hooks or service modules.

---

### 6.2 Application Layer

The application layer coordinates workflows.

Examples:

* Upload a document.
* Store the file.
* Start OCR.
* Save the provider response.
* Update processing status.
* Save edited text.
* Delete a document.
* Export local data.
* Import local data.

This layer should orchestrate operations without containing low-level database or provider code.

---

### 6.3 Data Layer

The data layer is responsible for IndexedDB.

It should provide methods such as:

* Create document.
* Read document.
* List documents.
* Update document.
* Delete document.
* Store file.
* Read file.
* Save provider settings.
* Read provider settings.
* Export all records.
* Import validated records.

All IndexedDB access should be centralized.

UI code should never create its own database transactions.

---

### 6.4 Provider Layer

The provider layer handles external OCR requests.

It should contain:

* Provider configuration validation.
* Request construction.
* Authentication headers.
* File conversion when required.
* Response parsing.
* Error normalization.

The provider layer should return a normalized application result.

Example normalized result:

```text
{
  text: "...",
  provider: "...",
  model: "...",
  processedAt: "...",
  rawMetadata: {}
}
```

The raw provider response should not be used directly by the interface.

---

### 6.5 File Handling Layer

The file layer should handle:

* MIME type detection.
* File validation.
* Blob conversion.
* Object URL creation.
* Object URL cleanup.
* File hashing if needed later.
* File size checks.
* Preview compatibility checks.
* Request preparation.

The MVP should avoid unnecessary conversions.

---

## 7. IndexedDB Design

A small number of object stores is sufficient.

### 7.1 Documents Store

Stores document metadata and extracted content.

Suggested fields:

```text
id
fileId
name
mimeType
size
createdAt
updatedAt
status
extractedText
editedText
providerName
model
processingError
schemaVersion
```

Indexes may include:

* `createdAt`
* `status`
* `name`

---

### 7.2 Files Store

Stores original files.

Suggested fields:

```text
id
blob
name
mimeType
size
createdAt
```

Separating files from document metadata prevents large binary values from being loaded when listing documents.

The document list should load metadata only.

The original file should be loaded only when the selected document needs preview or processing.

---

### 7.3 Settings Store

Stores provider and application settings.

Suggested fields:

```text
key
value
updatedAt
```

Settings may include:

* Active provider configuration.
* UI preferences.
* Database version.
* Export format version.

The MVP does not require multiple provider profiles.

---

## 8. Document Lifecycle

A document should follow a predictable lifecycle.

### Step 1: Upload

The user selects a file.

The application validates:

* File type.
* File size.
* Browser support.

If valid, the original file is stored immediately.

---

### Step 2: Record Creation

A document metadata record is created with status `uploaded` or `ready`.

The document appears in the sidebar.

---

### Step 3: Provider Validation

Before processing, the application verifies that provider settings exist and are complete.

Required checks:

* Endpoint exists.
* Model exists.
* API key exists when required.
* Endpoint uses a valid URL.
* Browser can attempt the request.

---

### Step 4: Processing

The document status changes to `processing`.

The application loads the original file, prepares the request, and sends it to the provider.

The process should be cancel-safe at the interface level, even if true request cancellation is not implemented in the first version.

The interface must prevent a second request from starting for the same document.

---

### Step 5: Result Storage

When processing succeeds:

* Store the extracted text.
* Copy the extracted text into the editable text field initially.
* Store provider and model metadata.
* Set status to `completed`.
* Clear previous error state.

---

### Step 6: Failure Handling

When processing fails:

* Set status to `failed`.
* Store a normalized error message.
* Preserve the original file.
* Preserve any previous successful extraction.
* Allow retry.

A failed OCR request must never delete or corrupt the uploaded file.

---

### Step 7: Editing

The user edits the extracted text.

The edited version is stored separately from the original provider result.

This protects the original extraction and supports reset behavior.

---

### Step 8: Deletion

The user confirms deletion.

The application removes all related file and document records in one coordinated operation.

---

## 9. User Interface Structure

The primary interface should use a three-region layout.

### 9.1 Left Sidebar

The left sidebar contains:

* Application identity.
* Upload control.
* Document list.
* Document status.
* Settings access.
* Storage usage indicator.
* Import and export controls.

The sidebar should remain compact.

The upload action should be visually prominent but not oversized.

The selected document should be clearly visible.

---

### 9.2 Main Preview Area

The center area displays the original document.

It should contain:

* File preview.
* File name.
* File type.
* File size.
* Processing state.
* Empty state when no document is selected.
* Unsupported-preview state when required.

The preview area should prioritize the document itself.

Controls should not cover the content.

---

### 9.3 Extracted Text Panel

The right panel contains:

* Processing action.
* Processing state.
* Extracted text editor.
* Save state.
* Reset action.
* Error state.
* Retry action.

The panel should make it obvious whether the displayed text is:

* Original extraction.
* Edited content.
* Unsaved content.

The MVP should avoid complex formatting controls.

---

## 10. Responsive Design

The desktop layout may use three visible regions.

On smaller screens:

* The sidebar may become a drawer.
* Preview and extracted text may switch to tabs.
* Settings should open in a full-screen sheet or dialog.
* Primary actions should remain reachable.
* Text editing should remain usable with the mobile keyboard.

The interface should not depend on hover interaction.

All important controls should work through touch and keyboard.

---

## 11. Design System

Tailwind CSS should be used to implement a small, consistent design system.

The design system should define:

* Typography scale.
* Spacing scale.
* Border radius.
* Surface hierarchy.
* Border colors.
* Text colors.
* Status colors.
* Focus styles.
* Button sizes.
* Input sizes.
* Dialog dimensions.
* Sidebar width.
* Panel spacing.

The application should avoid arbitrary values unless necessary.

Repeated visual patterns should become reusable components.

Core reusable components may include:

* Button.
* Icon button.
* Input.
* Textarea.
* Dialog.
* Dropdown.
* Status badge.
* Empty state.
* Error state.
* Loading indicator.
* File item.
* Panel header.
* Confirmation dialog.

---

## 12. Typography

Typography should be restrained.

Recommended hierarchy:

* Page title.
* Panel title.
* Section label.
* Body text.
* Supporting text.
* Metadata text.
* Status text.

The application should use a locally bundled font or a system font stack.

No remote font CDN should be used.

A strong system font stack is acceptable and reduces loading complexity.

---

## 13. Color and Visual Style

The interface should use a neutral base palette with one controlled accent color.

Recommended approach:

* Neutral background.
* Slightly elevated panels.
* Subtle borders.
* High-contrast primary text.
* Muted secondary text.
* One accent color for primary actions and selection.
* Dedicated semantic colors for success, warning, and error.

The application should avoid gradients, excessive shadows, glass effects, and decorative visual noise unless they serve a functional purpose.

Dark mode is not required for the MVP unless it is part of the initial design scope.

---

## 14. Interaction Design

### 14.1 Upload Feedback

After upload:

* The document should appear immediately.
* Storage should happen before OCR.
* The interface should confirm successful local storage.
* Processing should be a separate explicit action unless automatic OCR is intentionally selected.

An explicit process button gives users better control over provider cost and privacy.

---

### 14.2 Processing Feedback

While processing:

* Disable repeated processing.
* Show a clear status.
* Keep the original document visible.
* Do not replace the interface with a blocking full-screen loader.
* Preserve navigation unless leaving would create corruption.

The user should always understand what the system is doing.

---

### 14.3 Save Feedback

Text edits should save automatically or through a clear save action.

For the MVP, automatic local saving is appropriate if implemented reliably.

The interface should show:

* Saved.
* Saving.
* Save failed.

The status should remain subtle.

---

### 14.4 Error Feedback

Errors should explain:

* What failed.
* Why it may have failed.
* What data remains safe.
* What action is available.

Example categories:

* Unsupported file type.
* File too large.
* Missing provider configuration.
* Invalid provider endpoint.
* CORS failure.
* Authentication failure.
* Provider rate limit.
* Invalid provider response.
* Browser storage quota exceeded.
* Import validation failed.

Avoid showing raw technical stack traces to users.

Detailed diagnostic information may be available in a developer details section later, but it is not required for the MVP.

---

## 15. Security Considerations

### 15.1 API Key Exposure

A browser-only application cannot fully protect an API key.

The application must state:

* The key is stored locally.
* The key may be visible through browser developer tools.
* Restricted or low-risk keys should be used.
* Provider-side usage limits are recommended.

The application should not claim that local storage makes the key secret.

---

### 15.2 Untrusted Provider Output

Provider output must be treated as untrusted text.

The application should:

* Render extracted output as plain text.
* Avoid direct HTML rendering.
* Avoid using `dangerouslySetInnerHTML`.
* Escape all displayed content.
* Validate imported records.

This prevents malicious or malformed provider output from becoming executable interface content.

---

### 15.3 Endpoint Validation

The application should validate provider endpoints.

Recommended checks:

* Valid URL.
* HTTPS in production.
* No empty endpoint.
* No unsupported protocol.
* No accidental local file protocol.

The application should not send requests to arbitrary values without basic validation.

---

### 15.4 Local Data Deletion

Deletion should remove related local records.

The settings area should include a clear option to remove all local application data.

This operation should require confirmation.

---

## 16. Storage Considerations

The browser may limit storage based on:

* Browser implementation.
* Available disk space.
* User settings.
* Private browsing mode.
* Storage pressure.
* Device type.

The application should use the Storage API when available to estimate:

* Used storage.
* Available quota.

The UI should show approximate storage usage.

The application may request persistent storage where supported, but it should not depend on approval.

When storage is low, the user should receive a clear warning before upload or import.

---

## 17. Performance Considerations

The application should avoid loading all original files into memory.

Best practices:

* Load only document metadata for the sidebar.
* Load the original file only for the selected document.
* Release object URLs after use.
* Avoid Base64 conversion unless required.
* Avoid unnecessary file duplication.
* Keep database transactions small.
* Use asynchronous IndexedDB operations.
* Avoid rerendering the full document list during text editing.
* Save edits with controlled debounce timing.
* Keep large provider responses out of global UI state.

The document list should remain fast even when original files are large.

---

## 18. State Management

The MVP does not require a large state management framework.

Recommended state categories:

### Persistent State

Stored in IndexedDB:

* Documents.
* Original files.
* Extracted text.
* Edited text.
* Provider settings.

### Local Interface State

Stored in React component state:

* Selected document.
* Open dialog.
* Active mobile tab.
* Temporary form input.
* Current loading state.
* Temporary validation error.

### Derived State

Computed from stored data:

* Storage usage.
* Document count.
* Processing availability.
* Whether edits differ from extraction.

Avoid duplicating the same state across IndexedDB, component state, and global stores.

---

## 19. Validation Strategy

Validation should occur at every boundary.

### File Validation

Validate:

* File exists.
* Supported type.
* Reasonable size.
* Non-empty file.
* Preview compatibility.

### Provider Validation

Validate:

* Endpoint.
* Model.
* Authentication fields.
* Request configuration.

### Response Validation

Validate:

* HTTP status.
* Expected response shape.
* Extracted text exists.
* Returned value is text.
* Response is not unexpectedly empty.

### Import Validation

Validate:

* Archive structure.
* Metadata version.
* Required fields.
* File references.
* Duplicate identifiers.
* Binary file presence.

Validation logic should be centralized rather than embedded inside components.

---

## 20. Error Handling Architecture

The application should use normalized errors.

A normalized error may contain:

```text
code
message
cause
retryable
documentId
createdAt
```

Example error codes:

* `UNSUPPORTED_FILE`
* `FILE_TOO_LARGE`
* `PROVIDER_NOT_CONFIGURED`
* `INVALID_ENDPOINT`
* `CORS_BLOCKED`
* `AUTHENTICATION_FAILED`
* `RATE_LIMITED`
* `INVALID_RESPONSE`
* `NETWORK_ERROR`
* `STORAGE_QUOTA_EXCEEDED`
* `IMPORT_INVALID`

The UI should map error codes to understandable user messages.

Raw provider details should be stored only when useful and should not be displayed directly.

---

## 21. Accessibility Requirements

The application should include accessibility from the beginning.

Required considerations:

* Keyboard-accessible navigation.
* Visible focus indicators.
* Semantic buttons.
* Proper labels for form controls.
* Dialog focus management.
* Screen-reader descriptions.
* Sufficient text contrast.
* Status communication beyond color.
* Accessible drag-and-drop fallback.
* Proper heading structure.
* Support for reduced motion.
* Large enough touch targets.

The interface should remain understandable without icons.

Icons should support text labels or accessible names.

---

## 22. No-CDN Requirement

The application must not depend on any CDN.

All resources should be installed locally and bundled during build.

This includes:

* JavaScript libraries.
* CSS.
* Tailwind CSS.
* Icons.
* Fonts.
* PDF libraries.
* Image assets.
* Application illustrations.

External runtime dependencies should be limited to the configured LLM provider endpoint.

No remote script tags, external font imports, or CDN-hosted styles should be used.

---

## 23. Next.js Best Practices

The application should use the Next.js App Router.

Recommended practices:

* Use client components only where browser APIs are required.
* Keep layout and static shell components server-compatible when practical.
* Isolate IndexedDB logic inside client-side modules.
* Avoid accessing `window`, `document`, or IndexedDB during server rendering.
* Use dynamic imports for heavy preview libraries.
* Keep page-level components small.
* Use route-level loading and error boundaries where relevant.
* Keep application configuration separate from component code.
* Prefer static export compatibility.
* Avoid unnecessary API routes.

The application should clearly separate build-time behavior from browser runtime behavior.

---

## 24. Tailwind CSS Best Practices

Tailwind should be used consistently, not as uncontrolled inline styling.

Recommended practices:

* Define shared design tokens in Tailwind configuration.
* Build reusable components for repeated patterns.
* Avoid long duplicated class strings.
* Use semantic component variants.
* Keep spacing values consistent.
* Use responsive classes deliberately.
* Avoid excessive custom CSS.
* Use CSS variables for theme-level values.
* Keep focus and disabled states consistent.
* Avoid arbitrary colors in individual components.

Global CSS should remain small and focused on:

* Root variables.
* Typography defaults.
* Browser normalization.
* Selection styles.
* Scrollbar behavior when necessary.
* Application background.

---

## 25. Suggested MVP Screens

### 25.1 Main Workspace

The main screen contains:

* Sidebar.
* Upload action.
* Document list.
* Original document preview.
* Extracted text editor.
* Process action.
* Delete action.
* Settings access.

This should be the primary application screen.

---

### 25.2 Provider Settings Dialog

The provider settings dialog contains:

* Provider name.
* Endpoint.
* Model.
* API key.
* Optional request headers.
* OCR instruction.
* Save action.
* Connection test action only if it can remain simple.

A connection test is optional and should not become a complex diagnostic tool.

---

### 25.3 Import Dialog

The import dialog contains:

* Archive file selector.
* Validation status.
* Import summary.
* Confirm action.
* Error details.

---

### 25.4 Delete Confirmation Dialog

The delete dialog contains:

* File name.
* Clear warning.
* Confirm deletion.
* Cancel action.

---

## 26. Empty States

The application should include carefully designed empty states.

### No Documents

Show:

* Clear upload action.
* Short explanation of local storage.
* Supported file types.
* Privacy note.

### No Provider Configuration

Show:

* Provider configuration required.
* Link to settings.
* Explanation that OCR cannot begin without a provider.

### No Extracted Text

Show:

* Process action.
* Processing requirements.
* Current document status.

### Unsupported Preview

Show:

* File metadata.
* Download or export availability if implemented.
* Explanation that the file is stored but cannot be previewed.

---

## 27. Database Versioning

The IndexedDB database should use explicit versioning from the beginning.

The application should define:

* Database name.
* Database version.
* Object stores.
* Indexes.
* Upgrade migration function.

Every stored document should include a schema version.

This allows future releases to add fields or restructure records safely.

Database migrations should never silently delete user data.

---

## 28. Export Versioning

Export files should include a format version.

Example:

```text
exportVersion
applicationVersion
createdAt
documents
files
```

The import system should use the export version to determine compatibility.

The MVP should support only its initial export format, but the version field should still exist.

---

## 29. Testing Strategy

The MVP should include focused testing.

### Unit Tests

Test:

* File validation.
* Provider configuration validation.
* Response normalization.
* Error normalization.
* Export structure.
* Import validation.
* Document state transitions.

### Integration Tests

Test:

* Upload and local storage.
* Read file from IndexedDB.
* Process document.
* Save extraction result.
* Edit text.
* Delete document.
* Export and import.

### Interface Tests

Test:

* Empty state.
* Provider configuration flow.
* Processing state.
* Failed processing state.
* Document selection.
* Text editing.
* Delete confirmation.
* Mobile layout.

### Manual Browser Testing

Test at minimum:

* Chromium-based browser.
* Firefox.
* Safari where possible.
* Mobile viewport.
* Storage quota behavior.
* Private browsing limitations.
* Large image upload.
* Failed provider request.
* CORS rejection.

---

## 30. MVP Acceptance Criteria

The MVP is complete when all of the following are true:

1. A user can upload a supported file.
2. The original file is stored in IndexedDB.
3. The document remains available after page reload.
4. A user can configure a custom provider.
5. Provider settings remain available after page reload.
6. A user can send a stored document for OCR.
7. The application displays processing state.
8. The provider response is normalized into extracted text.
9. Extracted text is stored locally.
10. The extracted text remains available after page reload.
11. The user can edit and save the text.
12. The original extraction remains separate from the edited text.
13. The user can preview supported original files.
14. Failed processing preserves the original file.
15. The user can retry a failed process.
16. The user can delete a document.
17. Deletion removes both file and document records.
18. The user can export local documents.
19. The user can import a valid export.
20. The application works without a backend server.
21. No CDN resources are required.
22. The interface works on desktop and mobile layouts.
23. Basic keyboard navigation is supported.
24. Provider output is rendered safely as text.
25. Browser storage errors are handled clearly.

---

## 31. Recommended Implementation Sequence

### Phase 1: Foundation

* Create Next.js application.
* Configure Tailwind CSS.
* Define design tokens.
* Create main layout.
* Create IndexedDB wrapper.
* Define document and file records.

### Phase 2: Upload and Storage

* Build upload interface.
* Add file validation.
* Store original files.
* Store document metadata.
* Build document list.
* Restore documents after reload.

### Phase 3: Preview

* Add image preview.
* Add PDF preview.
* Add unsupported preview state.
* Manage object URL cleanup.

### Phase 4: Provider Configuration

* Build provider settings dialog.
* Add provider validation.
* Store settings locally.
* Build provider adapter interface.

### Phase 5: OCR Processing

* Add processing workflow.
* Add normalized errors.
* Store extraction results.
* Add retry behavior.
* Add clear processing states.

### Phase 6: Editing

* Add extracted text editor.
* Add local save behavior.
* Add reset to original extraction.
* Add unsaved and saved states.

### Phase 7: Delete, Export, and Import

* Add document deletion.
* Add confirmation dialog.
* Add export archive.
* Add import validation.
* Add restore workflow.

### Phase 8: Quality

* Refine responsive behavior.
* Improve accessibility.
* Add testing.
* Improve error messages.
* Optimize database reads.
* Review storage handling.
* Verify no-CDN compliance.

---

## 32. Final Technical Direction

The recommended MVP architecture is:

* Next.js App Router.
* JavaScript.
* Tailwind CSS.
* Client-side browser application.
* IndexedDB for files, documents, and settings.
* Blob storage for original files.
* Plain text storage for OCR results.
* One configurable custom LLM provider.
* Provider adapter abstraction.
* No backend.
* No CDN.
* No user accounts.
* No cloud database.
* No advanced schema editor.
* No collaboration.
* No feature expansion beyond the defined MVP.

The core workflow is:

1. Upload file.
2. Validate file.
3. Store original file.
4. Create document metadata.
5. Select document.
6. Configure provider.
7. Send document for OCR.
8. Normalize provider response.
9. Store extracted text.
10. Edit extracted text.
11. Export or delete local data.

The application should be small in capability but strong in structure. The MVP should establish reliable boundaries between user interface, storage, file handling, and provider communication. This will keep the first release understandable and maintainable while preserving a clear path for future expansion.
