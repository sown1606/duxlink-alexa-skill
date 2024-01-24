/********************************
 * Alexa Duxlink Health Skill
 * Copyright (c) of Duxlink Health 2023, a division of CVAUSA
 ********************************/

/*
 * This is an skill that lets users add vitals to duxlink system or create a meeting with doctor.
 */
const Alexa = require('ask-sdk-core');
const AWS = require('aws-sdk');
const ddbAdapter = require('ask-sdk-dynamodb-persistence-adapter');
var https = require('https');
const { v4: uuidv4 } = require('uuid');

/* HANDLERS */
//Check if Alexa already linking with DuxlinkHealth
const LaunchRequestHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'LaunchRequest';
    },
    async handle(handlerInput) {
        
        //debug account linking
        const accessToken = handlerInput.requestEnvelope.context.System.user.accessToken;
        console.log("Access Token:", accessToken);

        const persistentAttributes = await handlerInput.attributesManager.getPersistentAttributes();
        console.log("Persistent Attributes:", persistentAttributes);

        // Check for reminder permissions
        const permissions = handlerInput.requestEnvelope.context.System.user.permissions;
        const consentToken = permissions && permissions.consentToken;

        if (!consentToken) {
            // Request permissions if not granted
            return handlerInput.responseBuilder
                .speak('Please enable Reminder and Email permissions in the Alexa app.')
                .withAskForPermissionsConsentCard(['alexa::alerts:reminders:skill:readwrite', 'alexa::profile:email:read'])
                .getResponse();
        }

        // get persistent attributes, using await to ensure the data has been returned before
        // continuing execution
        var persistent = await handlerInput.attributesManager.getPersistentAttributes();
        persistent = {};

        // No need to check if 'isPinConfirmed' exists, just set it to false
        persistent.isPinConfirmed = false;
        await handlerInput.attributesManager.setPersistentAttributes(persistent);
        await handlerInput.attributesManager.savePersistentAttributes();


        //get data from patient email exist
        // Retrieve the user's email address
        const upsServiceClient = handlerInput.serviceClientFactory.getUpsServiceClient();
        let email;
        try {
            email = await upsServiceClient.getProfileEmail();
        } catch (error) {
            console.log(`Error retrieving email: ${error}`);
            return handlerInput.responseBuilder
                .speak('Sorry, I couldn\'t retrieve your email address. Please make sure you have given permissions in the Alexa app.')
                .getResponse();
        }

        if (!email) {
            return handlerInput.responseBuilder
                .speak('Sorry, I couldn\'t retrieve your email address. Please make sure you have given permissions in the Alexa app.')
                .getResponse();
        }


        const responseData = await getPatientInfoFromEmail(email);

        console.log('responseData from getPatientInfoFromEmail: ',responseData);

        if (!responseData.hasOwnProperty('response')) {
            //response error, need disable and link again
            const speakOutput = await 'Something wrong when try to get your information. Please try to disable skill, enable skill and try to link with your Patient Account again!';

            return handlerInput.responseBuilder
                .speak(speakOutput)
                .getResponse();
        } else {
            //save patient id for use later
            const persistent = {};
            // Instead of re-declaring persistent, update the existing object
            for (const key in responseData.response) {
                persistent[key] = responseData.response[key];
            }
            await handlerInput.attributesManager.setPersistentAttributes(persistent);
            await handlerInput.attributesManager.savePersistentAttributes();

            //get Reminders from server
            const remindersJSON = await getPatientReminders(responseData.response.pid);
            console.log('remindersJSON', remindersJSON);
            // Create reminders for each item in the JSON data
            for (const reminderId in remindersJSON.response) {
                const reminder = remindersJSON.response[reminderId];
                const daysOfWeek = reminder.days_of_week === 'all' ? ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] : reminder.days_of_week.split(',').map(day => day.slice(0, 2).toUpperCase());
                const timeOfDay = reminder.time_of_day + ':00'; // Add seconds to the time of day

                // Create the reminder
                const reminderRequest = {
                    requestTime: new Date().toISOString(),
                    trigger: {
                        type: 'SCHEDULED_ABSOLUTE',
                        scheduledTime: getNextOccurrence(daysOfWeek, timeOfDay), // Assuming the PHP server sends the time in UTC
                        timeZoneId: 'UTC', // Use the user's timezone
                        recurrence: {
                            freq: 'WEEKLY',
                            byDay: daysOfWeek,
                        },
                    },
                    alertInfo: {
                        spokenInfo: {
                            content: [{
                                locale: 'en-US',
                                text: `Reminder to ${reminder.type}${reminder.medication_info ? ': ' + reminder.medication_info : ''}.`,
                            }, ],
                        }
                    },
                    pushNotification: {
                        status: 'ENABLED',
                    },
                };

                //Delete all reminders added by DuxlinkHealth
                await deleteAllReminders(handlerInput);

                // Create the reminder if it doesn't already exist
                try {
                    const reminderResponse = await createReminder(handlerInput, handlerInput.requestEnvelope.context.System.device.deviceId, reminderRequest);
                } catch (error) {
                    console.error('Error creating reminder:', error);
                }
            }
            const speakOutput = `Welcome to Duxlink Health. After confirming your Profile PIN, you can add vitals, start survey. Please start by confirming your Profile PIN by saying, for example, "My pin is 1 2 3 4."`;
            // Instead of returning the response here, continue to execute the logic for PIN verification
            // Generate a unique token for PIN verification
            const uniqueToken = uuidv4();
            // Start a connection for PIN verification
            return handlerInput.responseBuilder
                .speak(speakOutput)
                .addDirective({
                    type: "Connections.StartConnection",
                    uri: "connection://AMAZON.VerifyPerson/2",
                    input: {
                        requestedAuthenticationConfidenceLevel: {
                            level: 400,
                            customPolicy: {
                                policyName: "VOICE_PIN",
                            },
                        },
                    },
                    token: uniqueToken,
                })
                .getResponse();
        }

    },
};

const SessionResumedRequestHandler = {
    canHandle(handlerInput) {
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) ===
            "SessionResumedRequest"
        );
    },
    async handle(handlerInput) {
        const connectionsStatus = handlerInput.requestEnvelope.request.cause.status;
        const connectionsCode = connectionsStatus.code;
        let speechText = '';

        if (connectionsCode !== "200") {
            speechText = "Sorry, something went wrong. Please try again.";
            console.error("Error: Verification connection status code is not 200. Code:", connectionsCode);
            return handlerInput.responseBuilder.speak(speechText).getResponse();
        }

        const verificationTaskStatus =
            handlerInput.requestEnvelope.request.cause.result.status;

        if (verificationTaskStatus === "ACHIEVED") {
            // Store in persistent attributes that PIN is confirmed
            let persistent = await handlerInput.attributesManager.getPersistentAttributes();
            persistent.isPinConfirmed = true;
            await handlerInput.attributesManager.setPersistentAttributes(persistent);
            await handlerInput.attributesManager.savePersistentAttributes();

            // Handle successful verification
            speechText = "Your PIN is correct. You can now say add new vitals or start survey. What can I help you with?";
        } else {
            speechText = "Sorry, the PIN verification failed. Please try again.";
            console.error("Error: Verification task status not achieved. Status:", verificationTaskStatus);
            return handlerInput.responseBuilder.speak(speechText).getResponse();
        }

        console.log("Connections Status Code: ", connectionsStatus);
        console.log("Verification Task Status: ", verificationTaskStatus);

        return handlerInput.responseBuilder.speak(speechText).withShouldEndSession(false).getResponse();
    },
};


//getNextOccurrence
function getNextOccurrence(daysOfWeek, timeOfDay) {
    const now = new Date();
    const currentDay = now.getUTCDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    const daysOfWeekNumbers = daysOfWeek.map(day => {
        switch (day) {
            case 'SU':
                return 0;
            case 'MO':
                return 1;
            case 'TU':
                return 2;
            case 'WE':
                return 3;
            case 'TH':
                return 4;
            case 'FR':
                return 5;
            case 'SA':
                return 6;
            default:
                return -1;
        }
    });

    const sortedDaysOfWeek = daysOfWeekNumbers.sort((a, b) => a - b);

    let targetDay = sortedDaysOfWeek.find(day => day > currentDay);
    if (targetDay === undefined) {
        targetDay = sortedDaysOfWeek[0];
    }

    const dayDifference = (targetDay + 7 - currentDay) % 7;
    const nextOccurrence = new Date(now.getTime() + dayDifference * 24 * 60 * 60 * 1000);
    nextOccurrence.setUTCHours(timeOfDay.split(':')[0]);
    nextOccurrence.setUTCMinutes(timeOfDay.split(':')[1]);
    nextOccurrence.setUTCSeconds(timeOfDay.split(':')[2]);

    const dateString = nextOccurrence.toISOString().replace(/\.\d{3}Z$/, '');
    console.log('Next occurrence:', dateString);
    return dateString;

}

// function createReminder
async function createReminder(handlerInput, deviceId, reminderRequest) {
    const serviceClientFactory = handlerInput.serviceClientFactory;
    const reminderManagementServiceClient = serviceClientFactory.getReminderManagementServiceClient();
    try {
        const reminderResponse = await reminderManagementServiceClient.createReminder(reminderRequest, deviceId);
        return reminderResponse;
    } catch (error) {
        console.error('Error creating reminder:', error);
        throw error;
    }
}

// function get all exists reminders
async function getAllReminders(handlerInput, deviceId) {
    const serviceClientFactory = handlerInput.serviceClientFactory;
    const reminderManagementServiceClient = serviceClientFactory.getReminderManagementServiceClient();
    try {
        const reminders = await reminderManagementServiceClient.getReminders(deviceId);
        return reminders.alerts || [];
    } catch (error) {
        console.error('Error getting reminders:', error);
        throw error;
    }
}

// Function to delete all existing reminders added by DuxlinkHealth
async function deleteAllReminders(handlerInput) {
    const reminderManagementServiceClient = handlerInput.serviceClientFactory.getReminderManagementServiceClient();

    // Retrieve all existing reminders
    let existingReminders;
    try {
        const remindersResponse = await reminderManagementServiceClient.getReminders();
        existingReminders = remindersResponse.alerts || [];
    } catch (error) {
        console.error('Error retrieving reminders:', error);
        return; // Exit the function if reminders cannot be retrieved
    }

    // Keep track of any errors
    let errors = [];

    for (const reminder of existingReminders) {
        try {
            await reminderManagementServiceClient.deleteReminder(reminder.alertToken);
        } catch (error) {
            console.error(`Error deleting reminder with ID ${reminder.alertToken}:`, error);
            errors.push({ alertToken: reminder.alertToken, error: error });
        }
    }

    // Check if there were any errors
    if (errors.length > 0) {
        console.error('Some reminders could not be deleted:', errors);
    } else {
        console.log('All reminders deleted successfully');
    }
}



//ADD VITALS FUNCTIONS
//Ask if patient add Vitals data
const AddVitalsIntentHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'IntentRequest' &&
            handlerInput.requestEnvelope.request.intent.name === 'AddVitalsIntent';
    },
    async handle(handlerInput) {
        let persistent = await handlerInput.attributesManager.getPersistentAttributes();
        try {
            persistent = await handlerInput.attributesManager.getPersistentAttributes();
        } catch (error) {
            console.log('Error retrieving persistent attributes:', error);
            // Handle error, e.g., tell the user there was a problem and end the session
        }

        if (!persistent.isPinConfirmed) {
            // Interrupt the dialog and ask for the PIN
            return handlerInput.responseBuilder
                .speak('Please provide your PIN before proceeding.')
                .reprompt('Please provide your PIN.')
                .getResponse();
        }

        const currentIntent = handlerInput.requestEnvelope.request.intent;
        const dialogState = handlerInput.requestEnvelope.request.dialogState;

        if (dialogState === 'STARTED') {
            // New dialog, prompt for the systolic slot
            return handlerInput.responseBuilder
                .addDelegateDirective(currentIntent)
                .getResponse();
        } else if (dialogState === 'IN_PROGRESS') {
            // Dialog in progress, check if systolic slot was filled
            const systolicSlotValue = Alexa.getSlotValue(handlerInput.requestEnvelope, 'systolic');
            if (!systolicSlotValue) {
                // Systolic slot not filled, ask user to provide it or skip
                const diastolicSlotValue = Alexa.getSlotValue(handlerInput.requestEnvelope, 'diastolic');
                if (!diastolicSlotValue) {
                    // Diastolic slot also not filled, skip both and move to the next slot
                    const slotToElicit = 'heartRate';
                    return handlerInput.responseBuilder
                        .addElicitSlotDirective(slotToElicit)
                        .getResponse();
                } else {
                    // Only systolic slot not filled, ask user to provide it or skip
                    const slotToElicit = 'systolic';
                    const speechText = 'What is the systolic value, or say skip to skip this question?';
                    const repromptText = 'Please provide the systolic value, or say skip to skip this question.';
                    return handlerInput.responseBuilder
                        .addElicitSlotDirective(slotToElicit)
                        .speak(speechText)
                        .reprompt(repromptText)
                        .getResponse();
                }
            }
            // All slots filled, continue with processing the intent
            return handlerInput.responseBuilder
                .addDelegateDirective(currentIntent)
                .getResponse();
        } else {
            // Dialog completed, handle the completed intent directly instead of using Dialog.Delegate
            return ConfirmVitalsHandler.handle(handlerInput);
        }
    }
};

// Handle the user's confirmation vitals
const ConfirmVitalsHandler = {
    canHandle(handlerInput) {
        const request = handlerInput.requestEnvelope.request;
        return request.type === 'IntentRequest' &&
            request.intent.name === 'AddVitalsIntent' &&
            request.dialogState === 'COMPLETED' &&
            request.intent.confirmationStatus === 'CONFIRMED';
    },
    async handle(handlerInput) {
        const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
        const slotValues = handlerInput.requestEnvelope.request.intent.slots;
        const systolic = (slotValues.systolic && slotValues.systolic.value) ? slotValues.systolic.value : null;
        const diastolic = (slotValues.diastolic && slotValues.diastolic.value) ? slotValues.diastolic.value : null;
        const heartRate = (slotValues.heartRate && slotValues.heartRate.value) ? slotValues.heartRate.value : null;
        const oxygenSaturation = (slotValues.oxygenSaturation && slotValues.oxygenSaturation.value) ? slotValues.oxygenSaturation.value : null;
        const weight = (slotValues.weight && slotValues.weight.value) ? slotValues.weight.value : null;
        const glucose = (slotValues.glucose && slotValues.glucose.value) ? slotValues.glucose.value : null;
        const urineOutput = (slotValues.urineOutput && slotValues.urineOutput.value) ? slotValues.urineOutput.value : null;

        let speakOutput;
        //Get pid
        const persistent = await handlerInput.attributesManager.getPersistentAttributes();
        //Check if patientID exist
        if (await persistent.hasOwnProperty('pid')) {
            // Save the vitals data to the database
            try {
                await saveVitals(persistent.pid, systolic, diastolic, heartRate, oxygenSaturation, weight, glucose, urineOutput);
                speakOutput = 'Vitals data has been successfully saved.';
            } catch (error) {
                console.log(error);
                speakOutput = 'There was an error saving the vitals data. Please try again later.';
            }
        } else {
            speakOutput = 'Missing pid, please try again!';
        }



        return handlerInput.responseBuilder
            .speak(speakOutput)
            .withShouldEndSession(false)
            .getResponse();
    },
};

// ADD SURVEYS
const SurveyIntentHandler = {
    canHandle(handlerInput) {
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === "SurveyIntent"
        );
    },
    async handle(handlerInput) {
        const persistent = await handlerInput.attributesManager.getPersistentAttributes();
        if (!persistent.isPinConfirmed) {
            const speakOutput = 'Please provide your PIN before proceeding.';
            return handlerInput.responseBuilder
                .speak(speakOutput)
                .reprompt(speakOutput)
                .getResponse();
        }
        let speakOutput = "";

        if (!persistent.hasOwnProperty("pid")) {
            return handlerInput.responseBuilder
                .speak("Missing pid, please contact support service!")
                .getResponse();
        }

        try {
            const surveyData = await getPatientSurvey(persistent.pid);
            const questionIds = Object.keys(surveyData.response);

            if (questionIds.length === 0) {
                speakOutput = "There are no survey questions available for you at this time.";
                return handlerInput.responseBuilder.speak(speakOutput).getResponse();
            }

            const attributesManager = handlerInput.attributesManager;
            const sessionAttributes = attributesManager.getSessionAttributes() || {};
            sessionAttributes.context = 'survey';
            const surveyResponses = sessionAttributes.surveyResponses || {};
            let currentQuestionIndex = sessionAttributes.currentQuestionIndex || 0;
            const currentQuestionId = questionIds[currentQuestionIndex];
            const currentQuestion = surveyData.response[currentQuestionId].question;
            const prompt = `Question ${currentQuestionIndex + 1}: ${currentQuestion}`;
            const rePrompt = `I didn't catch your response. Could you please repeat that?`;

            // If survey is not yet completed, save current survey data to session attributes
            sessionAttributes.surveyData = surveyData;
            sessionAttributes.currentQuestionIndex = currentQuestionIndex;
            attributesManager.setSessionAttributes(sessionAttributes);

            if (!surveyResponses[currentQuestionId]) {
                // If there is no response saved for the current question, ask for user input
                speakOutput = prompt;
                return handlerInput.responseBuilder
                    .speak(speakOutput)
                    .reprompt(rePrompt)
                    .withShouldEndSession(false)
                    .getResponse();
            } else {
                // If there is already a response saved for the current question, move on to the next question
                currentQuestionIndex += 1;

                if (currentQuestionIndex < questionIds.length) {
                    const nextQuestionId = questionIds[currentQuestionIndex];
                    const nextQuestion = surveyData.response[nextQuestionId].question;
                    const nextPrompt = `Question ${currentQuestionIndex + 1}: ${nextQuestion}`;

                    // Save user's response to the current question
                    const surveyResponse = sessionAttributes.surveyResponse;
                    surveyResponses[currentQuestionId] = surveyResponse;
                    sessionAttributes.surveyResponses = surveyResponses;

                    sessionAttributes.currentQuestionIndex = currentQuestionIndex;
                    attributesManager.setSessionAttributes(sessionAttributes);

                    return handlerInput.responseBuilder
                        .speak(nextPrompt)
                        .reprompt(nextPrompt)
                        .withShouldEndSession(false)
                        .getResponse();
                } else {
                    // All survey questions have been answered, save the responses and thank the user
                    const postData = JSON.stringify(surveyResponses);
                    // console.log('from survey intent handler', postData);

                    speakOutput = "Thank you for completing the survey.";

                    return handlerInput.responseBuilder
                        .speak(speakOutput)
                        .withShouldEndSession(false)
                        .getResponse();
                }
            }
        } catch (error) {
            console.log(error);
            return handlerInput.responseBuilder
                .speak(
                    "Sorry, I am having trouble fetching the survey data. Please try again later."
                )
                .getResponse();
        }
    },
};

const AnswerIntentHandler = {
    canHandle(handlerInput) {
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === "AnswerIntent"
        );
    },
    async handle(handlerInput) {
        const attributesManager = handlerInput.attributesManager;
        const sessionAttributes = attributesManager.getSessionAttributes() || {};
        const surveyResponses = sessionAttributes.surveyResponses || {};
        const persistent = await handlerInput.attributesManager.getPersistentAttributes();
        const surveyData = await getPatientSurvey(persistent.pid);
        const questionIds = Object.keys(surveyData.response);

        const currentQuestionIndex = sessionAttributes.currentQuestionIndex;
        const currentQuestionId = questionIds[currentQuestionIndex];
        const currentQuestion = surveyData.response[currentQuestionId].question;

        const answerSlot = Alexa.getSlot(handlerInput.requestEnvelope, "Answer");
        const answerYesNoSlot = Alexa.getSlot(handlerInput.requestEnvelope, "AnswerYesNo");

        let answer;

        if (answerSlot && answerSlot.value) {
            answer = answerSlot.value;
        } else if (answerYesNoSlot && answerYesNoSlot.value) {
            answer = answerYesNoSlot.value.toLowerCase();
        } else {
            // If neither slot is filled, prompt user to answer again
            return handlerInput.responseBuilder
                .speak("I'm sorry, I didn't hear your answer. Can you please repeat it?")
                .reprompt("Can you please repeat your answer?")
                .getResponse();
        }

        // Save user's response to session attributes
        sessionAttributes.surveyResponse = answer;
        attributesManager.setSessionAttributes(sessionAttributes);

        // Ask for confirmation of the user's response
        sessionAttributes.confirming = true;
        sessionAttributes.confirmedAnswer = answer;
        attributesManager.setSessionAttributes(sessionAttributes);

        return handlerInput.responseBuilder
            .speak(`You answered ${answer}. Is that right? Please say right or wrong to confirm your answer`)
            .reprompt("Please say right or wrong to confirm your answer.")
            .withShouldEndSession(false)
            .getResponse();
    },
};

const SurveyConfirmYesNoIntentHandler = {
    canHandle(handlerInput) {
        const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
        const currentIntent = Alexa.getIntentName(handlerInput.requestEnvelope);
        return (
            sessionAttributes.confirming &&
            handlerInput.requestEnvelope.request.type === "IntentRequest" &&
            (currentIntent === "SurveyYesIntent" || currentIntent === "SurveyNoIntent")
        );
    },
    async handle(handlerInput) {
        const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
        const persistent = await handlerInput.attributesManager.getPersistentAttributes();
        const surveyData = await getPatientSurvey(persistent.pid);
        const questionIds = Object.keys(surveyData.response);
        const currentQuestionIndex = sessionAttributes.currentQuestionIndex;

        // If user confirms their answer, save the answer and ask the next question
        if (handlerInput.requestEnvelope.request.intent.name === "SurveyYesIntent") {
            const surveyResponses = sessionAttributes.surveyResponses || {};
            const currentQuestionId = questionIds[currentQuestionIndex];
            const surveyData = sessionAttributes.surveyData;

            // Save the user's response to the current question
            surveyResponses[currentQuestionId] = sessionAttributes.confirmedAnswer;
            sessionAttributes.surveyResponses = surveyResponses;
            // Save the user's response to database
            //   await saveSurvey(persistent.pid, Object.keys(surveyResponses)[0],currentQuestionId,sessionAttributes.confirmedAnswer);

            return await askNextQuestion(handlerInput, sessionAttributes);
        } else {
            // If user does not confirm their answer, ask for the answer again
            const currentQuestion = surveyData.response[questionIds[currentQuestionIndex]].question;
            const prompt = `Please answer again. ${currentQuestion}`;
            const rePrompt = "I didn't catch your response. Could you please repeat that?";

            sessionAttributes.confirming = false;
            handlerInput.attributesManager.setSessionAttributes(sessionAttributes);

            return handlerInput.responseBuilder
                .speak(prompt)
                .reprompt(rePrompt)
                .withShouldEndSession(false)
                .getResponse();
        }
    },
};

const SkipQuestionSurveyIntentHandler = {
    canHandle(handlerInput) {
        const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
        return (
            Alexa.getRequestType(handlerInput.requestEnvelope) === "IntentRequest" &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === "SkipQuestionSurveyIntent" &&
            sessionAttributes.context === 'survey'

        );
    },
    async handle(handlerInput) {
        const attributesManager = handlerInput.attributesManager;
        const sessionAttributes = attributesManager.getSessionAttributes();
        sessionAttributes.context = 'survey';

        // Skip the current question and ask the next one
        return await askNextQuestion(handlerInput, sessionAttributes);
    },
};

async function askNextQuestion(handlerInput, sessionAttributes) {
    const persistent = await handlerInput.attributesManager.getPersistentAttributes();
    const { surveyData, surveyResponses } = sessionAttributes;
    const questionIds = Object.keys(surveyData.response);
    const currentQuestionIndex = sessionAttributes.currentQuestionIndex;
    const nextQuestionIndex = currentQuestionIndex + 1;

    if (nextQuestionIndex < questionIds.length) {
        const nextQuestionId = questionIds[nextQuestionIndex];
        const nextQuestion = surveyData.response[nextQuestionId].question;
        const nextPrompt = `Question ${nextQuestionIndex + 1}: ${nextQuestion}`;

        sessionAttributes.currentQuestionIndex = nextQuestionIndex;
        handlerInput.attributesManager.setSessionAttributes(sessionAttributes);

        return handlerInput.responseBuilder
            .speak(nextPrompt)
            .reprompt(nextPrompt)
            .withShouldEndSession(false)
            .getResponse();
    } else {
        // const postData = JSON.stringify(surveyResponses);
        saveSurvey(persistent.pid,surveyResponses);
        const speakOutput = "Your answer has been save into database. Thank you for completing the survey.";

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .withShouldEndSession(false)
            .getResponse();
    }
}

const HelpIntentHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest' &&
            Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
    },
    handle(handlerInput) {
        const speakOutput = 'You can add new vitals results by saying "add new vitals" or ask for help by saying "help"';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(speakOutput)
            .getResponse();
    },
};

const CancelAndStopIntentHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'IntentRequest' &&
            (handlerInput.requestEnvelope.request.intent.name === 'AMAZON.CancelIntent' ||
                handlerInput.requestEnvelope.request.intent.name === 'AMAZON.StopIntent');
    },
    handle(handlerInput) {
        const requestAttributes = handlerInput.attributesManager.getRequestAttributes();

        const speakOutput = 'Goodbye!';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .getResponse();
    },
};

// This function handles utterances that can't be matched to any
// other intent handler.
const FallbackIntentHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'IntentRequest' &&
            handlerInput.requestEnvelope.request.intent.name === 'AMAZON.FallbackIntent';
    },
    handle(handlerInput) {
        const requestAttributes = handlerInput.attributesManager.getRequestAttributes();

        const speakOutput = "The Duxlink Health skill can't help you with that.  It can help you add new vitals,start survey, or create meeting schedule with doctor. What can I help you with?";
        const repromptOutput = 'What can I help you with?';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(repromptOutput)
            .getResponse();
    },
};

const SessionEndedRequestHandler = {
    canHandle(handlerInput) {
        return handlerInput.requestEnvelope.request.type === 'SessionEndedRequest';
    },
    handle(handlerInput) {
        console.log(`Session ended with reason: ${handlerInput.requestEnvelope.request.reason}`);

        return handlerInput.responseBuilder.getResponse();
    },
};

// This function handles syntax or routing errors. If you receive an error
// stating the request handler chain is not found, you have not implemented
// a handler for the intent or included it in the skill builder below
const ErrorHandler = {
    canHandle() {
        return true;
    },
    handle(handlerInput, error) {
        console.log(`Error Request: ${JSON.stringify(handlerInput.requestEnvelope.request)}`);
        console.log(`Error handled: ${error.message}`);

        const requestAttributes = handlerInput.attributesManager.getRequestAttributes();
        const speakOutput = 'Something wrong, please contact support service!';
        const repromptOutput = 'Something wrong, please try again later or contact support service';

        return handlerInput.responseBuilder
            .speak(speakOutput)
            .reprompt(repromptOutput)
            .getResponse();
    },
};

// This function is used for testing and debugging. It will echo back an
// intent name for an intent that does not have a suitable intent handler.
// a respond from this function indicates an intent handler function should
// be created or modified to handle the user's intent.
const IntentReflectorHandler = {
    canHandle(handlerInput) {
        return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
    },
    handle(handlerInput) {
        const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
        const speakOutput = `You just triggered ${intentName}`;
        return handlerInput.responseBuilder
            .speak(speakOutput)
            // .reprompt('add a reprompt if you want to keep the session open for the user to respond')
            .getResponse();
    },
};

//API FUNCTIONS
//A fucntion that get user information
function getPatientInfoFromEmail(email) {

    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "email": email
            }
        };
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/getPatientInfoFromEmail',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}

//A function that get user's reminders list
function getPatientReminders(pid) {

    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "pid": parseInt(pid)
            }
        };
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/getAlexaReminderList',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}



//A function that get user's alexa pin code
function getPatientPinCode(pid) {

    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "pid": parseInt(pid)
            }
        };
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/getAlexaPatientPin',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}


//A function that get user's alexa pin code
function savePatientPinCode(pid,pinCode) {

    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "pinCode": pinCode,
                "pid": parseInt(pid)
            }
        };
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/saveAlexaPatientPin',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}

//A function that get user's start survey list
function getPatientSurvey(pid) {

    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "pid": parseInt(pid)
            }
        };
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/getSymptoms',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}

//A function that save vitals data
function saveVitals(pid, systolic, diastolic, heartRate, oxygenSaturation, weight, glucose, urineOutput) {

    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "bps": systolic,
                "bpd": diastolic,
                "pulse": heartRate,
                "oxygenSaturation": oxygenSaturation,
                "weight": weight,
                "glucose": glucose,
                "urineOutput": urineOutput,
                "pid": parseInt(pid),
            }
        };
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/postVitalsFromAlexa',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}

//A function that save survey data
function saveSurvey(pid, postData) {
    return new Promise(((resolve, reject) => {
        const dataToSend = {
            request_data: {
                "site": "duxlink",
                "postData": postData,
                "pid": parseInt(pid),
            }
        };
        console.log('from saveSurvey', dataToSend);
        var options = {
            hostname: 'api.duxlinkhealth.com',
            port: 443,
            path: '/postAlexaSurveys',
            method: 'POST',
            headers: {
                //Header Defination
                'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
            },
        };

        const request = https.request(options, (response) => {
            response.setEncoding('utf8');
            let returnData = '';

            response.on('data', (chunk) => {
                returnData += chunk;
            });

            response.on('end', () => {
                resolve(JSON.parse(returnData));
            });

            response.on('error', (error) => {
                reject(error);
            });
        });
        request.write(JSON.stringify(dataToSend));
        request.end();
    }));
}
/* LAMBDA SETUP */

// The SkillBuilder acts as the entry point for your skill, routing all request and response
// payloads to the handlers above. Make sure any new handlers or interceptors you've
// defined are included below. The order matters - they're processed top to bottom.
exports.handler = Alexa.SkillBuilders.custom()
    .addRequestHandlers(
        LaunchRequestHandler,
        SessionResumedRequestHandler,
        AddVitalsIntentHandler,
        ConfirmVitalsHandler,
        SurveyIntentHandler,
        AnswerIntentHandler,
        SurveyConfirmYesNoIntentHandler,
        SkipQuestionSurveyIntentHandler,
        HelpIntentHandler,
        CancelAndStopIntentHandler,
        FallbackIntentHandler,
        IntentReflectorHandler,
        SessionEndedRequestHandler,
    )
    .addErrorHandlers(ErrorHandler)
    .withApiClient(new Alexa.DefaultApiClient())
    .withPersistenceAdapter(
        new ddbAdapter.DynamoDbPersistenceAdapter({
            tableName: process.env.DYNAMODB_PERSISTENCE_TABLE_NAME,
            createTable: false,
            dynamoDBClient: new AWS.DynamoDB({
                apiVersion: 'latest',
                region: process.env.DYNAMODB_PERSISTENCE_REGION
            })
        })
    )
    .lambda();
