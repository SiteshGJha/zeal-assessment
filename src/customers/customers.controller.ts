import { Controller, Get, HttpStatus, Param, Query, Req } from '@nestjs/common';
import type { RequestWithActor } from '../auth/auth.types.js';
import { RequiredScopes } from '../auth/scopes.decorator.js';
import { ProblemException } from '../common/problem-details.filter.js';
import { CustomersService, type CustomerAggregateDto } from './customers.service.js';

/**
 * Exposes aggregated customer entitlement and usage endpoints.
 */
@Controller('v1/customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get(':id')
  @RequiredScopes('support:read')
  async getCustomer(
    @Param('id') id: string,
    @Query('includeUsage') includeUsageRaw: string | undefined,
    @Req() req: RequestWithActor,
  ): Promise<CustomerAggregateDto> {
    let includeUsage = true;
    if (includeUsageRaw !== undefined) {
      if (includeUsageRaw === 'true') {
        includeUsage = true;
      } else if (includeUsageRaw === 'false') {
        includeUsage = false;
      } else {
        throw new ProblemException(HttpStatus.UNPROCESSABLE_ENTITY, {
          title: 'Unprocessable Entity',
          detail: 'Query validation failed',
          errors: [{ field: 'includeUsage', message: 'includeUsage must be true or false' }],
        });
      }
    }

    return this.customersService.getCustomerById(id, req.actor!, includeUsage);
  }
}
