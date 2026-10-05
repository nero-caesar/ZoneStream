export type AccountRole = "individual" | "church" | "zonal";
export type AccountStatus = "active" | "pending";

export type AccountProfile = {
  uid: string;
  role: AccountRole;
  status: AccountStatus;
  displayName: string;
  email?: string;
  churchCodeHash?: string;
  churchCodeEncrypted?: string;
  churchName?: string;
  churchLocation?: string;
  churchType?: "local" | "group";
  phone?: string;
  createdAt?: string;
};

export type PublicAccountProfile = Omit<AccountProfile, "churchCodeHash" | "churchCodeEncrypted">;
