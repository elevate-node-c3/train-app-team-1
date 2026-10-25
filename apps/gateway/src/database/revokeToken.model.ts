import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('revoke_token')
export class revokeTokenModel {
    @PrimaryGeneratedColumn('uuid')
    id : string;
    @Column('varchar')
    token:string;
    @Column('varchar')
    userId:string;
    @Column('date')
    expiryDate:Date
}