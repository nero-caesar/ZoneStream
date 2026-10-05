import type { AccountProfile, PublicAccountProfile } from "./types";

export function toPublicAccountProfile(profile: AccountProfile): PublicAccountProfile {
  const publicProfile = { ...profile };
  delete publicProfile.churchCodeHash;
  delete publicProfile.churchCodeEncrypted;
  return publicProfile;
}
