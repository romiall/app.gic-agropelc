export {
  areAttachmentsAvailable,
  attachmentsOfOwners,
  hasAvailableAttachment,
  requiredAttachmentsSatisfied,
} from './attachment-query.js';
export type { OwnedAttachment } from './attachment-query.js';

// AV-539 (ADR-070) : archive des photos jointes (plans, volumes, photos), lue et écrite par la couche de transport.
export {
  archivedItemOfAttachment,
  cancelArchivePlan,
  completeArchiveIfDone,
  countPurgedItems,
  getArchive,
  getVolume,
  insertArchivePlan,
  listArchives,
  listLivePlans,
  listVolumeItems,
  listVolumes,
  loadArchiveCandidates,
  lockArchive,
  markItemsPurged,
  markItemsReleased,
  purgedMonthAggregates,
  recordVolumeAborted,
  recordVolumeDelivered,
  recordVolumeVerified,
  resolveVolumeIfDone,
  serverMonthAggregates,
} from '../archive/archive-store.js';
export type {
  ArchiveCandidate,
  ArchiveItemRecord,
  ArchiveItemState,
  ArchiveRecord,
  ArchiveReleaseReason,
  ArchiveStatus,
  ArchiveVolumeRecord,
  MonthAggregate,
  NewArchiveItem,
  NewArchivePlan,
  NewArchiveVolume,
} from '../archive/archive-store.js';
