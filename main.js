require('dotenv').config();
const express = require('express');
const querystring = require('querystring');
const axios = require('axios');
const session = require('express-session');
const hubspot = require('@hubspot/api-client');
const NodeCache = require('node-cache');
const SimpleDateFormat = require('@riversun/simple-date-format');
const cron = require('node-cron');
const bodyParser = require('body-parser')
const { access } = require('fs');
const { equal } = require('assert');

const limit = 10;
const after = undefined;
const properties = undefined;
const propertiesWithHistory = undefined;
const associations = undefined;
const archived = false;

const app = express();

const jsonParser = bodyParser.json()

//app.use(bodyParser.json());

//Cache für Access-Token um TTL festzulegen
const accessTokenCache = new NodeCache();

const hubspotClient = new hubspot.Client();

app.set('view engine', 'pug');

const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const SCOPES = 'crm.objects.contacts.read';

const REDIRECT_URI = 'http://localhost:3000/oauth-callback';

const authUrl =
  'https://app.hubspot.com/oauth/authorize' +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`; 

//Variable um Refreshtokens zu speichern --> in Produktionsumgebung wäre das eine Datenbank (hier nur zu Demozwecken als Objekt)
const refreshTokenStore = {};

//Match User mit ihren Tokens (SessionID erzeugt) -- saveUninitialized = true --> Session im SessionStore gespeichert
app.use(session({
    secret: Math.random().toString(36).substring(2),
    resave: false,
    saveUninitialized: true
}));

//Funktion um zu prüfen ob Token im Tokenstore ist, welcher UserID zuegeordnet ist (wenn ja - true returned)
//geht mit access- und refresh-Token, da beide am Ende des OAuth-Prozesses ausgestellt werden
const isAuthorized = (userID) => {
    return refreshTokenStore[userID] ? true : false;
};

//check cached Access-Token and return --> wenn nicht vorhanden new refresh-Token
const getToken = async (userID) => {
  if(accessTokenCache.get(userID)) {
    return accessTokenCache.get(userID);
  } else {
    try {
      //siehe https://developers.hubspot.com/docs/api/oauth-quickstart-guide#
      const refreshTokenProof = {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        refresh_token: refreshTokenStore[userID]
      };

      //Refresh-Token erhalten (POST-Request an OAuth-Server) und in RefreshTokenStore senden
      const responseBody = await axios.post('https://api.hubapi.com/oauth/v1/token', querystring.stringify(refreshTokenProof));
      refreshTokenStore[userID] = responseBody.data.refresh_token;
      accessTokenCache.set(userID, responseBody.data.access_token, 600);
      console.log('getting refresh-token');
      return accessTokenCache.get(userID);
    } catch (error) {
      console.error(error);
    }
  }
}

//Auth-Flow
//1: Nutzer an Auth-URL weiterleiten --> Installationsprozess beginnt / im Header werden Access-Token und Content-Type übergeben (bei Get-Req an API)
//siehe: https://developers.hubspot.com/docs/api/oauth-quickstart-guide
app.get('/', async (req, res) => {
    //check ob autorisiert
    if (isAuthorized(req.sessionID)) {
        const accessToken = await getToken(req.sessionID);
        hubspotClient.setAccessToken(accessToken);
        console.log(req.sessionID);

        //get alle Contacts die in den letzten 24 Stunden erstellt wurden
        //TODO: Alternative zu Webhook-Kontaktabfang implementieren
        const today = new Date().getTime();
        console.log(today);
        const yesterday = new Date().getTime() - (24 * 60 * 60 * 1000);
        console.log(yesterday);

        try {
          const apiResponse = await hubspotClient.crm.contacts.basicApi.getPage(
            limit, 
            after, 
            properties, 
            propertiesWithHistory, 
            associations, 
            archived
            );
          console.log(JSON.stringify(apiResponse, null, 2));

          const data = JSON.stringify({
            "filterGroups": [
              {
                "filters": [
                  {
                    "propertyName":"lastmodifieddate",
                    "operator":"BETWEEN",
                    "highValue": today,
                    "value": yesterday
                  }
                ]
              }
            ],
            "properties": [
              "firstname",
              "email"
            ],
            "limit": 10
          });
          
          const config = {
            method: 'post',
            url: 'https://api.hubapi.com/crm/v3/objects/contacts/search',
            headers: { 
              'Authorization': `Bearer ${accessToken}`, 
              'Content-Type': 'application/json'
            },
            data : data
          };
          
          axios(config)
          .then(function (response) {
            console.log(JSON.stringify(response.data));
          })
          .catch(function (error) {
            console.log(error);
          });

          res.render('home', {
            token: accessToken,
            contacts: apiResponse.results
          });
      } catch (e) {
        console.error(e);
      }
    }else{
        res.render("home", {authUrl});
    }
});

//Handle Post-Request von Webhook - Anzeige der KontaktID des erstellten Kontakts - Info über diesen aus Account ziehen (objectId = contactId)
app.post('/submit', jsonParser, async (req,res) =>{

    //TODO: Methode um ObjectId jedes einzelnen Webhooks in Contact umzuwandeln --> dann bei mehreren Webhooks nacheinander abarbeiten (Test)
    const webhookResponse = req.body;
    console.log('ObjectId ist: ', webhookResponse[0].objectId);
    const contactId = webhookResponse[0].objectId;
    
    //Aufruf Contacts-API - isAuthorized noch einbauen/ sessionId? - Cookie untersuchen!
    const accessToken = await getToken(req.sessionID);
    hubspotClient.setAccessToken(accessToken)
    try {
      const apiResponse = await hubspotClient.crm.contacts.basicApi.getById(contactId);
      console.log(JSON.stringify(apiResponse, null, 2));
    } catch (e) {
      console.error(e)
    }

    //Anfrage beenden und HTTP 200 senden
    res.status(200).end();
});

//2: Auth-Code vom OAuth-Server bekommen
//3: Auth-Code mit App-Credentials kombinieren und an OAuth-Server schicken (Post formData mit Axios an OAuth-Server (axios.post))
app.get('/oauth-callback', async (req, res) => {

        const tokenProof = {
            grant_type: 'authorization_code',
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            redirect_uri: REDIRECT_URI,
            code: req.query.code
          };
          
        try {
            const responseBody = await axios.post('https://api.hubapi.com/oauth/v1/token', querystring.stringify(tokenProof));
            //4: Access- und Refresh-Token erhalten, Access-Token nutzen um API-Call zu machen
            refreshTokenStore[req.sessionID] = responseBody.data.refresh_token;
            //Access-Token in Cache, TTL = 600 Sekunden
            accessTokenCache.set(req.sessionID, responseBody.data.access_token, 600);

           /*
            axios.post('https://hubspot.cixon.space/_hcms/api/pipedrive-webhook', {
            accessToken: responseBody.data.access_token,
            refreshToken: responseBody.data.refresh_token
            })
            */

            res.redirect('/');
        } catch (error) {
            console.error(error);
        }
  });

app.listen(3000, () => console.log('App läuft auf http://localhost:3000'));

