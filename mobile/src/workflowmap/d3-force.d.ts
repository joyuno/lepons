// Only the part of d3-force the workflow map uses: @types/d3-force would be a
// second new dependency for a handful of signatures.
declare module "d3-force" {
  export interface SimulationNode {
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
    fx?: number | null;
    fy?: number | null;
  }
  export interface Force {
    (alpha: number): void;
  }
  export interface Simulation {
    force(name: string, force: Force | null): this;
    tick(iterations?: number): this;
    stop(): this;
  }
  export function forceSimulation<N extends SimulationNode>(nodes?: N[]): Simulation;
  export interface LinkForce<N, L> extends Force {
    id(id: (node: N) => string): this;
    distance(distance: number | ((link: L) => number)): this;
    strength(strength: number | ((link: L) => number)): this;
  }
  export function forceLink<N, L>(links?: L[]): LinkForce<N, L>;
  export interface CollideForce extends Force {
    strength(strength: number): this;
    iterations(iterations: number): this;
  }
  export function forceCollide<N>(radius?: number | ((node: N) => number)): CollideForce;
  export interface XForce<N> extends Force {
    strength(strength: number | ((node: N) => number)): this;
  }
  export function forceX<N>(x?: number | ((node: N) => number)): XForce<N>;
}
