export type {
  Organization,
  OrganizationMember,
  OrganizationInvitation,
  RoleAssignment,
  CreateOrganizationInput,
  CreateOrganizationMemberInput,
  CreateInvitationInput,
  CreateRoleAssignmentInput,
  AcceptInvitationInput,
  BootstrapOrganizationInput,
  MembershipRepository,
  MembershipResult,
  MembershipRepositoryError,
  CursorPosition,
  PageQueryParams,
  PagedResult,
} from "./types.js";

export { createMembershipRepository } from "./repository.js";
export { effectiveBillingOrgId } from "./billing-scope.js";

export type { TeamRecord, TeamMemberRecord, TeamInvitationRecord, NewTeamInvitation, TeamSettingsRecord, TeamSettingsChanges } from "./team.js";
export {
  findTeam,
  updateTeam,
  updateTeamSettings,
  listTeamMembers,
  findTeamMember,
  findTeamMemberBySubject,
  countTeamOwners,
  setTeamMemberRole,
  removeTeamMember,
  listTeamInvitations,
  findTeamInvitation,
  findTeamInvitationByEmail,
  createTeamInvitation,
  closeTeamInvitation,
  addTeamMember,
} from "./team.js";

export type { TeamDeletionBlockers, TeamOwnedRecords, TeamDeployResources } from "./team-danger.js";
export { teamDeployResources, countSubjectTeams, deleteTeam } from "./team-danger.js";

// DP-79: the platform operator's Admin View — every user, the teams they belong to, subscriptions (read only).
export {
  listPlatformUsers,
  countPlatformSubscribers,
  type PlatformUsersQuery,
  type PlatformUserRecord,
  type PlatformUserSort,
  type PlatformTeamFilter,
} from "./platform-admin.js";
