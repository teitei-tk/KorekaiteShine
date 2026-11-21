export type ExplorationTarget = 'preparation' | 'history';

export type ExplorationOptions = {
  target: ExplorationTarget;
  seconds: number;
  outputDirectory?: string;
  reproduce?: string;
};

export type ExplorationResult = {
  status: 'passed' | 'violated' | 'incomplete' | 'infrastructure_error';
  actions: number;
  reached: string[];
  artifactDirectory: string;
};
