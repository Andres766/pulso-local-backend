import type { Request, Response } from 'express';
import type {
  CreateBusiness,
  DeleteBusiness,
  GetBusiness,
  ListBusinesses,
  UpdateBusiness,
} from '../../../application/use-cases/businesses/BusinessUseCases.js';
import { createBusinessSchema, updateBusinessSchema, uuidParam } from '../schemas.js';

export class BusinessController {
  constructor(
    private readonly createBusiness: CreateBusiness,
    private readonly listBusinesses: ListBusinesses,
    private readonly getBusiness: GetBusiness,
    private readonly deleteBusiness: DeleteBusiness,
    private readonly updateBusiness: UpdateBusiness,
  ) {}

  list = async (req: Request, res: Response) => {
    const items = await this.listBusinesses.execute(req.userId!);
    res.json({ items: items.map((b) => b.toJSON()) });
  };

  create = async (req: Request, res: Response) => {
    const business = await this.createBusiness.execute(req.userId!, createBusinessSchema.parse(req.body));
    res.status(201).json(business.toJSON());
  };

  show = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    res.json((await this.getBusiness.execute(id, req.userId!)).toJSON());
  };

  update = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    const business = await this.updateBusiness.execute(id, req.userId!, updateBusinessSchema.parse(req.body));
    res.json(business.toJSON());
  };

  remove = async (req: Request, res: Response) => {
    const { id } = uuidParam.parse(req.params);
    await this.deleteBusiness.execute(id, req.userId!);
    res.status(204).end();
  };
}
