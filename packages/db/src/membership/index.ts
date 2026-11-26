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

export type { TeamRecord, TeamMemberRecord, TeamInvitationRecord, NewTeamInvitation } from "./team.js";
export {
  findTeam,
  updateTeam,
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
