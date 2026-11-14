import { useMemo, useState, type JSX } from 'react';
import { FolderOutput } from 'lucide-react';
import { specToAgentDir, type AgentSpecV2 } from '@linuxdevil/lousho/spec';

import { errorMessage } from '../../../components/errorMessage';
import { runtimeClient, RuntimeApiError } from '../../../runtime/runtimeClient';
import { ConfirmDialog } from '../../../ui/Dialog';
import { useToast } from '../../../ui/Toast';
import { Checkbox } from '../../../ui/controls';

interface EjectToProjectProps {
  agentId: string;
  spec: AgentSpecV2;
  /** The spec's change signal (`record.updatedAt`): the file count memoizes on it. */
  updatedAt: string;
}

/**
 * The "Eject to project" action (A08b): POSTs `/agents/:id/eject` after a
 * confirmation that states the generated file count. A 409
 * LOUSHO_EJECT_EXISTS keeps the dialog open, lists the count and offers an
 * overwrite checkbox that resends with `overwrite: true`.
 */
export function EjectToProject({ agentId, spec, updatedAt }: EjectToProjectProps): JSX.Element {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [exists, setExists] = useState<number>();
  const [overwrite, setOverwrite] = useState(false);

  // The dialog's file count: the same pure generator the dir view runs.
  // A spec that cannot render as a directory shows 0 - the server reports
  // the real error on confirm.
  const fileCount = useMemo(() => {
    try {
      return specToAgentDir(spec).files.length;
    } catch {
      return 0;
    }
  }, [updatedAt]);

  const close = () => {
    setOpen(false);
    setError(undefined);
    setExists(undefined);
    setOverwrite(false);
  };

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await runtimeClient.ejectAgent(agentId, overwrite);
      close();
      toast.show({ message: `Ejected to agents/${agentId}/`, tone: 'success' });
    } catch (err) {
      setError(errorMessage(err));
      if (err instanceof RuntimeApiError && err.status === 409 && err.code === 'LOUSHO_EJECT_EXISTS') {
        const files = (err.details as { files?: unknown } | undefined)?.files;
        setExists(Array.isArray(files) ? files.length : 0);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>
        <FolderOutput size={14} strokeWidth={1.75} aria-hidden="true" />
        Eject to project
      </button>
      <ConfirmDialog
        open={open}
        tone="primary"
        title="Eject to project?"
        description={`Writes ${fileCount} files to agents/${agentId}/ in this workspace. The Studio keeps editing .lousho/agents/${agentId}.yaml; the ejected copy won’t follow later changes.`}
        confirmLabel="Eject"
        pendingLabel="Ejecting…"
        pending={busy}
        error={error}
        onConfirm={() => void confirm()}
        onCancel={close}
      >
        {exists !== undefined ? (
          <Checkbox
            label="Overwrite existing files"
            description={`${exists} files will be replaced.`}
            checked={overwrite}
            disabled={busy}
            onChange={(event) => setOverwrite(event.target.checked)}
          />
        ) : null}
      </ConfirmDialog>
    </>
  );
}
