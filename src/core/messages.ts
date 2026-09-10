import type {
  ApiRequest,
  Collection,
  HistoryEntry,
  KeyValue,
  SendResult,
} from './types';

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; request: ApiRequest }
  | { type: 'save'; request: ApiRequest }
  | { type: 'saveToCollection'; request: ApiRequest }
  | { type: 'pickFile' }
  | { type: 'parseCurl'; text: string }
  | { type: 'revealVariable'; name: string }
  | { type: 'abort' }
  | { type: 'loadFileBytes'; field: string; path: string }
  | { type: 'dirty'; dirty: boolean }
  | { type: 'buildCurl'; request: ApiRequest }
  | { type: 'setFollowRedirects'; value: boolean }
  | { type: 'setHexView'; hex: boolean; offsets: boolean }
  | { type: 'downloadBody' }
  | { type: 'revealFile'; path: string }
  | { type: 'resendBinary'; mode: 'download' | 'text'; request: ApiRequest }
  | { type: 'newRequest' };

export interface VarInfo {
  value: string;
  source: string;
}

export type HostToWebview =
  | {
      type: 'init';
      request: ApiRequest;
      saved: boolean;
      vars: Record<string, VarInfo>;
      followRedirects: boolean;
    }
  | { type: 'vars'; vars: Record<string, VarInfo> }
  | { type: 'curlParsed'; request: ApiRequest }
  | { type: 'curlText'; curl: string }
  | {
      type: 'result';
      result: SendResult;
      missing: string[];
      sentUrl: string;
      binaryTextLimit?: number;
      rawHexView?: boolean;
      rawHexOffsets?: boolean;
    }
  | { type: 'sending'; hasUpload: boolean }
  | { type: 'uploadProgress'; sent: number; total: number }
  | {
      type: 'streamStart';
      status: number;
      statusText: string;
      headers: KeyValue[];
      contentType: string;
    }
  | { type: 'streamChunk'; text: string; totalBytes: number }
  | { type: 'saveRequested' }
  | { type: 'binaryIncoming'; contentType: string; totalBytes: number }
  | { type: 'downloadProgress'; received: number; total: number }
  | {
      type: 'downloadDone';
      path: string;
      bytes: number;
      result: SendResult;
      sentUrl: string;
      binaryTextLimit?: number;
      rawHexView?: boolean;
      rawHexOffsets?: boolean;
    }
  | {
      type: 'sentBody';
      info: {
        boundary?: string;
        files?: {
          name: string;
          fileName: string;
          bytes: number;
          preview?: string;
        }[];
        totalBytes: number;
      };
    }
  | {
      type: 'fileChunk';
      field: string;
      text: string;
      bytesRead: number;
      totalBytes: number;
    }
  | {
      type: 'fileDone';
      field: string;
      bytesRead: number;
      totalBytes: number;
      note: string;
    }
  | { type: 'fileBytesError'; field: string; message: string }
  | { type: 'saved'; request: ApiRequest }
  | { type: 'activitySaved'; request: ApiRequest }
  | { type: 'filePicked'; path: string };

export type SidebarToHost =
  | { type: 'ready' }
  | { type: 'newRequest' }
  | { type: 'newCollection' }
  | { type: 'openRequest'; colId: string; requestId: string }
  | { type: 'newFolder'; colId: string; containerId: string }
  | { type: 'newRequestIn'; colId: string; containerId: string }
  | { type: 'rename'; colId: string; nodeId: string; kind: NodeKind }
  | { type: 'delete'; colId: string; nodeId: string; kind: NodeKind }
  | { type: 'requestDeleteInfo'; colId: string; nodeId: string; kind: NodeKind }
  | { type: 'newEnv' }
  | { type: 'openEnv'; envId: string }
  | { type: 'activateEnv'; envId: string | null }
  | { type: 'renameEnv'; envId: string }
  | { type: 'requestEnvDeleteInfo'; envId: string }
  | { type: 'deleteEnv'; envId: string }
  | { type: 'openCollectionEnv'; colId: string }
  | { type: 'import' }
  | { type: 'importCurl' }
  | { type: 'exportCollection'; colId: string }
  | { type: 'exportEnv'; envId: string }
  | { type: 'copyCurl'; colId: string; requestId: string }
  | { type: 'openHistory'; entryId: string }
  | { type: 'clearHistory' }
  | { type: 'replayHistory'; entryId: string }
  | { type: 'duplicate'; colId: string; nodeId: string; kind: NodeKind }
  | { type: 'linkDotenv' }
  | { type: 'reloadDotenv'; envId: string }
  | { type: 'exportDotenv'; envId: string }
  | {
      type: 'move';
      colId: string;
      nodeId: string;
      kind: NodeKind;
      targetColId?: string;
      targetContainerId: string;
      beforeNodeId: string | null;
      copy?: boolean;
    }
  | {
      type: 'moveCollection';
      colId: string;
      beforeColId: string | null;
    }
  | { type: 'convertEnv'; colId: string; to: 'embedded' | 'linked' }
  | { type: 'revealVariable'; name: string }
  | { type: 'toggle'; nodeId: string; expanded: boolean }
  | { type: 'refresh' };

export type NodeKind = 'collection' | 'folder' | 'request';

export type HostToSidebar =
  | {
      type: 'tree';
      collections: Collection[];
      expanded: string[];
      envNames: Record<string, string>;
    }
  | { type: 'activeRequest'; requestId: string | null }
  | {
      type: 'deleteInfo';
      colId: string;
      nodeId: string;
      kind: NodeKind;
      name: string;
      requestCount: number;
      folderCount: number;
    }
  | {
      type: 'envs';
      environments: { id: string; name: string; varCount: number }[];
      activeEnvId: string | null;
      collectionEnvModes: {
        colId: string;
        colName: string;
        mode: string;
        linkedNames: string[];
        dotenv: boolean;
      }[];
    }
  | { type: 'envDeleteInfo'; envId: string; name: string; varCount: number }
  | { type: 'history'; entries: HistoryEntry[] };
