# Alexa Duxlink Health Skill

[![Alexa Skill](https://img.shields.io/badge/Alexa-Skill-blue)](https://developer.amazon.com/alexa/console/ask)
![Node.js](https://img.shields.io/badge/Node.js-14.x-brightgreen)

**Version:** 1.0  
**Author:** Duxlink Health (CVAUSA)

## Description

The **Alexa Duxlink Health Skill** allows users to interact with their health data via voice commands. With this skill, users can:
- Add vital health information (e.g., blood pressure, heart rate, weight).
- Complete health surveys.
- Set reminders for medications and health tasks.
- Schedule appointments with doctors (future feature).

This skill integrates with the Duxlink Health system via secure API calls.

## Features
- **Add Vitals**: Record systolic/diastolic pressure, heart rate, oxygen saturation, and more.
- **Surveys**: Respond to health surveys provided by the Duxlink system.
- **Reminders**: Automatically retrieve and set health-related reminders.
- **Doctor Appointments**: (Coming soon) Schedule meetings with doctors via Duxlink.

## Prerequisites

Before setting up the skill, you’ll need:
- An **Amazon Developer Account** to create and manage your Alexa skill.
- An **AWS Lambda function** to host the skill.
- **AWS DynamoDB** for persistent storage.
- **Duxlink Health API access** to manage patient and vitals data.

## Tech Stack
- **Node.js** (version 14.x or above)
- **Alexa SDK (ask-sdk-core)** for handling Alexa requests.
- **AWS SDK (DynamoDB, Lambda)** for persistence and cloud functions.
- **HTTPS requests** to communicate with the Duxlink API.

## Setup and Deployment

### 1. Clone the Repository
Clone this repository to your local machine:
```bash
git clone https://github.com/your-username/alexa-duxlink-health-skill.git
2. Install Dependencies
Install the necessary Node.js packages:
cd alexa-duxlink-health-skill
npm install
3. Create the Alexa Skill
Go to the Alexa Developer Console and create a new skill.
Set the interaction model for intents such as AddVitalsIntent, SurveyIntent, and AnswerIntent.
4. Set Up AWS Lambda
Go to the AWS Console and create a new Lambda function.
Set the runtime to Node.js 14.x.
Copy the code from this repository into the Lambda function.
Set environment variables for DynamoDB and Duxlink API:
DYNAMODB_PERSISTENCE_TABLE_NAME
DYNAMODB_PERSISTENCE_REGION
5. Set Up DynamoDB
Create a DynamoDB table in AWS to store user data (e.g., patient IDs, confirmed PINs).
Use the ask-sdk-dynamodb-persistence-adapter for persistence.
6. Configure Permissions
In the Alexa Developer Console, enable the following permissions:
alexa::alerts:reminders:skill:readwrite
alexa::profile:email:read
7. Deploy to AWS
Deploy your skill using the ASK CLI:
ask deploy
8. Test the Skill
Go to the Test tab in the Alexa Developer Console.
Use sample phrases such as:
"Alexa, ask Duxlink Health to add my vitals."
"Alexa, ask Duxlink Health to start a survey."
Environment Variables
Make sure to configure the following environment variables in your Lambda function:

Variable	Description
DYNAMODB_PERSISTENCE_TABLE_NAME	Name of your DynamoDB table for persistence
DYNAMODB_PERSISTENCE_REGION	AWS region where DynamoDB is hosted
DUXLINK_API_BASE_URL	Base URL for the Duxlink API
DUXLINK_API_KEY	API key to authenticate requests to the Duxlink API
Usage
Sample Commands
Add Vitals: "Alexa, ask Duxlink Health to add my vitals."
Start Survey: "Alexa, ask Duxlink Health to start a survey."
Set Reminder: "Alexa, ask Duxlink Health to remind me to take my medication."
Common Issues
Permission Errors: Ensure permissions for reminders and email are granted in the Alexa app.
Account Linking: If there is an issue with account linking, disable and re-enable the skill.
