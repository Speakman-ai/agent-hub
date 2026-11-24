import { useCallback, useRef, useState } from 'react';
import { createUseSessionFolders } from '@shared/hooks/useSessionFolders';
import { api } from '../utils/api';

export type { SessionFoldersByAgentId } from '@shared/hooks/useSessionFolders';

const useSharedSessionFolders = createUseSessionFolders({ useState, useRef, useCallback });

export function useSessionFolders() {
  return useSharedSessionFolders(api);
}
