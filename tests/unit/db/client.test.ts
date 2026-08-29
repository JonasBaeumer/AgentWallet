// Unit test: verify prisma client module exports correctly (no DB connection needed)
describe('DB client module', () => {
  it('exports a prisma client instance and raises Decimal precision first', () => {
    const decimalSet = jest.fn();
    const constructed: string[] = [];

    // We don't connect to DB in unit tests — just verify the module loads. The
    // mock has to carry Prisma.Decimal because the module configures decimal.js
    // precision for DECIMAL(78,0) atomic amounts before constructing the client.
    jest.mock('@prisma/client', () => {
      return {
        Prisma: {
          Decimal: {
            set: (...args: unknown[]) => {
              constructed.push('decimal-set');
              decimalSet(...args);
            },
          },
        },
        PrismaClient: jest.fn().mockImplementation(() => {
          constructed.push('prisma-client');
          return { $connect: jest.fn(), $disconnect: jest.fn() };
        }),
      };
    });

    const { prisma } = require('@/db/client');

    expect(prisma).toBeDefined();
    expect(decimalSet).toHaveBeenCalledWith({ precision: 100 });
    // Ordering matters: decimal.js configuration must be in place before any
    // Decimal instance the client produces is used in arithmetic.
    expect(constructed).toEqual(['decimal-set', 'prisma-client']);
  });
});
