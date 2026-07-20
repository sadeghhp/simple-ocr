'use client';

import { Workspace } from '@/components/layout/Workspace';
import { AppStateProvider } from '@/hooks/useAppState';

export default function Home() {
  return (
    <AppStateProvider>
      <Workspace />
    </AppStateProvider>
  );
}
