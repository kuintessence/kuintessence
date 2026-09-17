export const Role = {
  SUPER_ADMIN: "super_admin",
  PLATFORM_ADMIN: "platform_admin",
  OPERATOR: "operator",
  ORG_ADMIN: "org_admin",
  USER: "user",
  GUEST: "guest",
} as const;

export type RoleName = (typeof Role)[keyof typeof Role];

const ROLE_IMPLICATIONS: Readonly<Record<RoleName, readonly RoleName[]>> = {
  [Role.GUEST]: [Role.GUEST],
  [Role.USER]: [Role.USER, Role.GUEST],
  [Role.ORG_ADMIN]: [Role.ORG_ADMIN, Role.USER, Role.GUEST],
  [Role.OPERATOR]: [Role.OPERATOR, Role.USER, Role.GUEST],
  [Role.PLATFORM_ADMIN]: [
    Role.PLATFORM_ADMIN,
    Role.ORG_ADMIN,
    Role.OPERATOR,
    Role.USER,
    Role.GUEST,
  ],
  [Role.SUPER_ADMIN]: [
    Role.SUPER_ADMIN,
    Role.PLATFORM_ADMIN,
    Role.ORG_ADMIN,
    Role.OPERATOR,
    Role.USER,
    Role.GUEST,
  ],
};

export function hasRole(userRole: RoleName, requiredRole: RoleName): boolean {
  return ROLE_IMPLICATIONS[userRole]?.includes(requiredRole) ?? false;
}
