import { Inject, Injectable } from '@nestjs/common';
import { envs } from 'src/config/envs';
import Stripe from 'stripe';
import { PaymentSessionDto } from './dto/payment-session.dto';
import { Request, Response } from 'express';
import { ClientProxy } from '@nestjs/microservices';
import { NATS_SERVICE } from 'src/config/services';

@Injectable()
export class PaymentsService {
    private readonly stripe = new Stripe(envs.stripeSecret);

    constructor(
        @Inject(NATS_SERVICE) private readonly client: ClientProxy
    ) { }

    async createPaymentSession(paymentSessionDto: PaymentSessionDto) {
        const { currency, items, orderId } = paymentSessionDto;

        const lineItems = items.map(item => {
            return {
                price_data: {
                    currency: currency,
                    // product_data es para crear el producto en el momento.
                    product_data: {
                        name: item.name
                    },
                    unit_amount: Math.round(item.price * 100), // 20 dólares. Entero que ya tiene los decimales
                },
                quantity: item.quantity
            }
        })

        // En esta sesión se envía la info de lo que se desea cobrar. Va a crear una URL para poder redirigir usuarios o que ellos mismos naveguen
        const session = await this.stripe.checkout.sessions.create({
            // Colocar ID de orden
            payment_intent_data: {
                metadata: {
                    orderId
                } // Información adicional del registro del intento de pago
            },

            // Items que se están comprando
            line_items: lineItems,
            mode: 'payment',
            success_url: envs.stripeSuccessUrl,
            cancel_url: envs.stripeCancelUrl,
        });

        //return session;

        return {
            cancelUrl: session.cancel_url,
            successUrl: session.success_url,
            url: session.url
        }
    }

    // Stipe pide el body en su forma cruda
    async stripeWebhook(req: Request, res: Response) {
        const sig = req.headers['stripe-signature']!;

        let event: Stripe.Event;

        // Real
        const endpointSecret = envs.stripeEndpointSecret;

        try {
            event = this.stripe.webhooks.constructEvent(
                req['rawBody'],
                sig,
                endpointSecret,
            );
        } catch (err) {
            console.log(err)
            res.status(400).send(`Webhook Error: ${err.message}`);
            return;
        }

        // Se disparan tres eventos del webhook, por lo que se debe capturar el deseado.
        // 1. Se crea el intento. 2. El intento fue creado. 3. Intento succeeded.
        switch (event.type) {
            case 'charge.succeeded':
                const chargeSucceeded = event.data.object;
                const payload = {
                    stripePaymentId: chargeSucceeded.id,
                    orderId: chargeSucceeded.metadata.orderId,
                    receiptUrl: chargeSucceeded.receipt_url
                }

                this.client.emit('payment.succeeded', payload);
                break;

            default:
                console.log(`Event ${event.type} not handled`);
        }

        return res.status(200).json({ sig });
    }
}
