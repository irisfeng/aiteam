#!/usr/bin/env node
import { coworkerMeIsAdmin } from "../server/dist/coworker.js";

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, received ${actual}`);
  }
  console.log(`✅ ${label}`);
}

const baseUser = {
  id: "user-1",
  displayName: "Member",
  email: "member@example.com",
};

assertEqual(
  coworkerMeIsAdmin({
    ...baseUser,
    departments: [{ id: "dept-1", name: "Operations", role: "member" }],
  }),
  false,
  "A Coworker department member is not an AITeam administrator",
);

assertEqual(
  coworkerMeIsAdmin({
    ...baseUser,
    departments: [{ id: "dept-1", name: "Operations", role: "admin" }],
  }),
  true,
  "A Coworker department administrator can use AITeam admin routes",
);

assertEqual(
  coworkerMeIsAdmin({
    ...baseUser,
    departments: [],
    isSuperadmin: true,
  }),
  true,
  "A Coworker superadministrator can use AITeam admin routes",
);

assertEqual(
  coworkerMeIsAdmin({
    ...baseUser,
  }),
  false,
  "A malformed Coworker profile without departments fails closed",
);
