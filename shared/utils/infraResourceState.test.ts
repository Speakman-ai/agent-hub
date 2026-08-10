/**
 * State classification. The cases that matter are the ones where AWS spells
 * "healthy" differently per service, and the ones where an unrecognised value
 * must not be reported as a fault.
 *
 * Value sets verified against the live AWS API references (ECS Cluster/Service,
 * EC2 InstanceState, RDS DBInstance, ELBv2 LoadBalancerState, Lambda
 * FunctionConfiguration, EC2 NatGateway).
 */
import { describe, it, expect } from 'vitest';
import { infraResourceHealth, isInfraResourceHealthy } from './infraResourceState.js';

describe('infraResourceHealth', () => {
  it('accepts the healthy state of every service, whatever its casing', () => {
    // The regression this module exists for: ECS is UPPERCASE, Lambda is
    // TitleCase, ELBv2 is lowercase, and a predicate matching only `running`
    // and `available` called all of them abnormal.
    expect(infraResourceHealth('running')).toBe('healthy'); // EC2
    expect(infraResourceHealth('available')).toBe('healthy'); // RDS, NAT gateway
    expect(infraResourceHealth('ACTIVE')).toBe('healthy'); // ECS cluster + service
    expect(infraResourceHealth('Active')).toBe('healthy'); // Lambda
    expect(infraResourceHealth('active')).toBe('healthy'); // ELBv2
  });

  it('does not flag an RDS instance that is busy but still serving', () => {
    // A nightly backup window is not an incident. Flagging it teaches operators
    // to ignore the warning colour.
    expect(infraResourceHealth('backing-up')).toBe('healthy');
    expect(infraResourceHealth('storage-optimization')).toBe('healthy');
  });

  it('flags states that mean not-serving', () => {
    expect(infraResourceHealth('stopped')).toBe('unhealthy');
    expect(infraResourceHealth('terminated')).toBe('unhealthy');
    expect(infraResourceHealth('shutting-down')).toBe('unhealthy');
    expect(infraResourceHealth('INACTIVE')).toBe('unhealthy'); // ECS's "deleted"
    expect(infraResourceHealth('DRAINING')).toBe('unhealthy');
    expect(infraResourceHealth('failed')).toBe('unhealthy');
    expect(infraResourceHealth('deleting')).toBe('unhealthy');
  });

  it('flags a load balancer that routes but cannot scale', () => {
    // Contains the word "active" and is still a problem, which is why the
    // healthy check is set membership rather than a substring test.
    expect(infraResourceHealth('active_impaired')).toBe('unhealthy');
  });

  it('flags the open-ended RDS failure families by prefix', () => {
    // AWS adds variants over time; matching the family keeps a new one classified.
    expect(infraResourceHealth('incompatible-network')).toBe('unhealthy');
    expect(infraResourceHealth('incompatible-parameters')).toBe('unhealthy');
    expect(infraResourceHealth('inaccessible-encryption-credentials')).toBe('unhealthy');
    expect(infraResourceHealth('inaccessible-encryption-credentials-recoverable')).toBe(
      'unhealthy',
    );
  });

  it('reports an unrecognised state as unknown, never as broken', () => {
    // RDS publishes no closed enum for DBInstanceStatus, so "not on our healthy
    // list" cannot be allowed to mean "faulty".
    expect(infraResourceHealth('storage-config-upgrade')).toBe('unknown');
    expect(infraResourceHealth('some-state-aws-added-last-week')).toBe('unknown');
    expect(infraResourceHealth('provisioning')).toBe('unknown');
  });

  it('treats an absent state as unknown rather than a fault', () => {
    // S3 buckets and ELBv2 target groups carry no lifecycle at all.
    expect(infraResourceHealth(null)).toBe('unknown');
    expect(infraResourceHealth(undefined)).toBe('unknown');
    expect(infraResourceHealth('   ')).toBe('unknown');
  });

  it('ignores surrounding whitespace', () => {
    expect(infraResourceHealth('  running  ')).toBe('healthy');
  });
});

describe('isInfraResourceHealthy', () => {
  it('is true only for positively-known-good states', () => {
    expect(isInfraResourceHealthy('ACTIVE')).toBe(true);
    expect(isInfraResourceHealthy('stopped')).toBe(false);
    // Unknown is not healthy — but it is not a fault either, which is the
    // distinction `infraResourceHealth` keeps and this boolean cannot.
    expect(isInfraResourceHealthy('provisioning')).toBe(false);
  });
});
