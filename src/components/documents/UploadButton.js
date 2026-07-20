'use client';

import { useRef } from 'react';
import { Button } from '@/components/common/Button';
import { UploadIcon } from '@/components/common/icons';
import { ACCEPT_ATTRIBUTE } from '@/lib/files/validation';

/**
 * Primary upload action backed by the browser file picker — the
 * keyboard-accessible path alongside drag-and-drop (spec §21).
 */
export function UploadButton({ onFiles, disabled = false }) {
  const inputRef = useRef(null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTRIBUTE}
        multiple
        className="sr-only"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          if (event.target.files?.length) onFiles(event.target.files);
          event.target.value = '';
        }}
      />
      <Button
        variant="primary"
        className="w-full"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        <UploadIcon size={15} />
        Upload files
      </Button>
    </>
  );
}
