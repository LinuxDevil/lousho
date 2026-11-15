import { useEffect, useRef } from 'react';
import { useAppState } from './AppState';
import { useToast } from '../ui/Toast';

export function AutosaveErrorToast(): null {
  const { autosaveError } = useAppState();
  const toast = useToast();
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (autosaveError === undefined) {
      shown.current = undefined;
      return;
    }
    if (shown.current === autosaveError) return;
    shown.current = autosaveError;
    toast.show({ message: `Not saved: ${autosaveError}`, tone: 'error' });
  }, [autosaveError, toast]);
  return null;
}
