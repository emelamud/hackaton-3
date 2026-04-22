export interface PublicRoomCatalogEntry {
  id: string;
  /** Channels always carry a non-null name at the DB level. */
  name: string;
  description: string | null;
  memberCount: number;
  createdAt: string;
  /** True when the caller is already a `room_members` row for this id. FE renders "Open" vs "Join". */
  isMember: boolean;
}

export interface PublicCatalogResponse {
  rooms: PublicRoomCatalogEntry[];
  hasMore: boolean;
  /** Id of the last row in the page — pass back as `?cursor=` for the next request. null when hasMore=false. */
  nextCursor: string | null;
}
