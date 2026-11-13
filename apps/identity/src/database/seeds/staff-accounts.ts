/** Production staff passwords must come from the environment, not dev defaults. */
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
