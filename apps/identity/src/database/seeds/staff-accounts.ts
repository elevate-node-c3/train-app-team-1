/**
 * The two BR-01 staff accounts. The standalone seed creates them; the
 * passwords come from the environment so a production deployment never
 * inherits a development credential.
 */
export const STAFF_SEED_ACCOUNTS = [
  {
    id: '00000000-0000-4000-8000-0000000000a1',
    email: 'operator@train.local',
    role: 'operator',
    passwordEnv: 'OPERATOR_SEED_PASSWORD',
    developmentPassword: 'Operator!Dev123',
  },
  {
    id: '00000000-0000-4000-8000-0000000000a2',
    email: 'conductor@train.local',
    role: 'conductor',
    passwordEnv: 'CONDUCTOR_SEED_PASSWORD',
    developmentPassword: 'Conductor!Dev123',
  },
] as const;
