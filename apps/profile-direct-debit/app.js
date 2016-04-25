"use strict";

var	express = require( 'express' ),
	app = express();

var config = require( '../../config/config.json' );

var auth = require( '../../src/js/authentication.js' ),
	Permissions = require( '../../src/js/database' ).Permissions,
	Members = require( '../../src/js/database' ).Members;

var gocardless = require( 'gocardless' )( config.gocardless );

var app_config = {};

app.set( 'views', __dirname + '/views' );

app.use( function( req, res, next ) {
	res.locals.app = app_config;
	res.locals.breadcrumb.push( {
		name: 'Profile',
		url: '/profile'
	} );
	res.locals.breadcrumb.push( {
		name: app_config.title,
		url: app.mountpath
	} );
	res.locals.activeApp = 'profile';
	next();
} );

app.post( '/setup', auth.isLoggedIn, function( req, res ) {
	if ( req.body.amount < ( req.user.gocardless.minimum ? req.user.gocardless.minimum : config.gocardless.minimum ) ) {
		req.flash( 'danger', 'Minimum direct debit amount is £' + config.gocardless.minimum );
		return res.redirect( app.mountpath );
	}

	var url = gocardless.subscription.newUrl( {
		amount: req.body.amount,
		interval_unit: 'month',
		interval_length: '1',
		name: 'Membership',
		user: {
			first_name: req.user.firstname,
			last_name: req.user.lastname,
			email: req.user.email,
			"billing_address1": "TEST",
			"billing_town": "London",
			"billing_postcode": "E8 4DQ"
		}
	} );

	Members.update( { _id: req.user._id }, { $set: { "gocardless.amount": req.body.amount } }, function ( err ) {
		res.redirect( url );
	} );
} );

app.get( '/confirm', auth.isLoggedIn, function( req, res ) {
	gocardless.confirmResource( req.query, function( err, request, body ) {
		if ( err ) return res.end( 401, err );
		Members.update( { _id: req.user._id }, { $set: { "gocardless.id": req.query.resource_id } }, function ( err ) {
			req.flash( 'success', 'Direct Debit setup succesfully' );
			res.redirect( app.mountpath );
		} );
	} );
} );

app.get( '/', auth.isLoggedIn, function( req, res ) {
	res.render( 'index', {
		gocardless: req.user.gocardless,
		amount: ( req.user.gocardless.minimum ? req.user.gocardless.minimum : config.gocardless.minimum )
	} );
} );

app.get( '/cancel', auth.isLoggedIn, function( req, res ) {
	res.render( 'cancel' );
} );

app.post( '/cancel', auth.isLoggedIn, function( req, res ) {
	gocardless.subscription.cancel( {
		id: req.user.gocardless.id
	}, function( err,response, body ) {
		var response = JSON.parse( body );

		if ( response.status == 'cancelled' ) {
			Members.update( { _id: req.user._id }, { $set: { gocardless: { id: '', amount: '' } } }, function( err ) {
				req.flash( 'success', 'Direct debit cancelled' );
				res.redirect( app.mountpath );
			} );
		} else {
			req.flash( 'danger', 'Error cancelling direct debit' );
			res.redirect( app.mountpath );
		}
	} );
} );

app.post( '/webhook', function( req, res ) {
	if ( gocardless.webhookValid( req.body ) ) {

		if ( req.body.payload.bills != undefined ) {
			var bills = req.body.payload.bills;
			for ( var b in bills ) {
				var bill = bills[b];

				switch ( bill.status ) {
				
					case 'pending':
						upsertTransaction( bill.source_id, bill.id, bill.status, bill.amount );
						break;
				
					case 'paid':
						upsertTransaction( bill.source_id, bill.id, bill.status, bill.amount, function() {
							grExtendMembership( bill.source_id, function() {
								// ACTION: check Discourse group
							} );
						} );
						break;
				
					case 'failed':
						upsertTransaction( bill.source_id, bill.id, bill.status, bill.amount );
						break;
				
					case 'withdrawn':
						upsertTransaction( bill.source_id, bill.id, bill.status, bill.amount );
						break;
				}
			}
		}

		if ( req.body.payload.subscriptions != undefined ) {
			var subscriptions = req.body.payload.subscriptions;
			for ( var s in subscriptions ) {
				var subscription = subscriptions[s];
				if ( subscription.status == 'cancelled' ) {
					Members.findOne( { "gocardless.id": subscription.id }, function( err, member ) {
						if ( member == undefined ) return;
						member.gocardless.id = '';
						member.gocardless.amount = '';
						member.save( function( err ) {} );
					} );
				}
			}
		}
		res.sendStatus( 200 );
	} else {
		res.sendStatus( 403 );
	}
} );

// Update/insert transaction
function upsertTransaction( subscription_id, bill_id, status, amount, callback ) {
	Members.findOne( { 'gocardless.id': subscription_id }, function( err, member ) {
		if ( member == undefined && typeof callback == 'function' ) callback();
		if ( member == undefined ) return;

		var transactions = member.gocardless.transactions;
		var exists;

		// Look for existing transaction record
		for ( var t = 0; t < transactions.length; t++ ) {
			var transaction = transactions[t];
			if ( transaction.bill_id == bill_id ) {
				exists = t;
				break;
			}
		}

		var transaction = {};

		// Update existing
		if ( exists != null ) {
			transaction = transactions[exists];
			transaction.status = status;

		// Or create new
		} else {
			transaction = {
				date: new Date(),
				description: 'Membership',
				bill_id: bill_id,
				subscription_id: subscription_id,
				amount: amount,
				status: status
			}
			transactions.push( transaction );
		}

		// Save changes
		member.save( function( err ) {
			if ( callback != undefined ) callback();
		} );
	} );
}

// Grant/extend membership
function grExtendMembership( subscription_id, callback ) {
	Members.findOne( { 'gocardless.id': subscription_id } ).populate( 'permissions.permission' ).exec( function( err, member ) {
		if ( member == undefined ) callback();

		var member_permision = member.permissions.filter( function( perm ) {
			return perm.permission.slug == 'member';
		} );

		var new_expiry = new Date();
		new_expiry.setDate( new_expiry.getDate() + 31 );


		if ( member_permision.length == 0 ) {
			Permissions.findOne( { slug: 'member' }, function( err, perm ) {
				if ( perm == undefined ) return;

				var permission = {
					permission: perm._id,
					date_added: new Date(),
					date_expires: new_expiry
				}
				member.permissions.push( permission );

				member.save( function( err ) {
					callback();
				} );
			} );
		} else {
			member_permision = member_permision[0];

			if ( member_permision.date_expires < new_expiry ) {
				member_permision.date_expires = new_expiry;
			}

			member.save( function( err ) {
				callback();
			} );
		}
	} );
}

module.exports = function( config ) {
	app_config = config;
	return app;
};